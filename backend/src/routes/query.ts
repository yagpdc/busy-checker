import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import {
  currentMeeting,
  eventsAround,
  meetingsTodayCount,
  nextFreeSlot,
} from "../services/calendar.js";
import type { CalendarEventLite } from "../services/calendar.js";
import {
  findEmailInDirectory,
  searchDirectory,
} from "../services/directory.js";
import type { DirectoryCandidate } from "../services/directory.js";
import { emailForNameHint, presenceForEmail } from "../services/presence.js";
import {
  answerQuestion,
  openaiEnabled,
  parseQuestion,
} from "../services/openai.js";
import type { ChatMessage } from "../services/openai.js";
import {
  isOutsideWorkingHours,
  templateStatusReply,
} from "../services/replies.js";

const router = Router();

const body = z.object({
  // Latest input. At least one of email/name/question must be present.
  // `question` requires OpenAI configured.
  question: z.string().min(1).max(500).optional(),
  targetEmail: z.string().email().optional(),
  targetName: z.string().min(1).max(120).optional(),
  // Conversation history (prior turns). Last element should be the user's
  // current message OR the assistant's most recent reply — the route
  // doesn't care which, it just feeds them to the model.
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(20)
    .optional(),
  // Carry-over target from the previous turn. When the new question doesn't
  // reference anyone (pronoun follow-up like "e amanhã?"), we resolve to
  // this person instead of failing.
  contextTargetEmail: z.string().email().optional(),
  workStartHour: z.number().int().min(0).max(23).optional(),
  workEndHour: z.number().int().min(1).max(24).optional(),
});

router.post("/", requireSession, async (req, res) => {
  const t0 = Date.now();
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    console.warn("[query] bad_request", parse.error.issues);
    res.status(400).json({ error: "bad_request" });
    return;
  }
  console.log(
    "[query] in",
    JSON.stringify({
      hasEmail: !!parse.data.targetEmail,
      hasName: !!parse.data.targetName,
      hasQuestion: !!parse.data.question,
      historyLen: parse.data.messages?.length ?? 0,
      hasContextTarget: !!parse.data.contextTargetEmail,
      questionPreview: parse.data.question?.slice(0, 80) ?? null,
    }),
  );

  const asker = await clientForUser(req.session!.userId);
  const history: ChatMessage[] = parse.data.messages ?? [];

  // Resolution priority for the current turn:
  //   1. explicit targetEmail
  //   2. explicit targetName → local users → directory
  //   3. parsed `question` via OpenAI:
  //        a. extracts email/hint, considers prior turns for context
  //        b. hint → directory search; if multi-match, return candidates
  //   4. carry-over `contextTargetEmail` (pronoun follow-ups)
  let targetEmail: string | null = parse.data.targetEmail ?? null;
  let displayHint: string | null = parse.data.targetName ?? null;
  // Populated when the user named someone but we got multiple matches —
  // sent down to OpenAI so it phrases a disambiguation question.
  let candidates: DirectoryCandidate[] = [];

  async function resolveByHint(hint: string): Promise<string | null> {
    const local = await emailForNameHint(hint);
    if (local) return local;
    return await findEmailInDirectory(asker, hint);
  }

  if (!targetEmail && parse.data.targetName) {
    targetEmail = await resolveByHint(parse.data.targetName);
    if (!targetEmail) {
      // Surface candidates so the model can disambiguate.
      candidates = await searchDirectory(asker, parse.data.targetName);
    }
  }

  if (!targetEmail && parse.data.question) {
    if (!openaiEnabled) {
      res.status(400).json({
        error: "needs_email_or_name",
        message:
          "OpenAI não configurado: passe targetEmail ou targetName direto, sem question.",
      });
      return;
    }
    const parsed = await parseQuestion(parse.data.question, history).catch(
      (err) => {
        console.error("[query] parseQuestion failed", err);
        return { targetEmail: null, targetHint: null };
      },
    );
    console.log("[query] parsed", JSON.stringify(parsed));
    targetEmail = parsed.targetEmail;
    displayHint = displayHint ?? parsed.targetHint;
    if (!targetEmail && parsed.targetHint) {
      targetEmail = await resolveByHint(parsed.targetHint);
      console.log(
        "[query] resolveByHint",
        parsed.targetHint,
        "→",
        targetEmail,
      );
      if (!targetEmail) {
        candidates = await searchDirectory(asker, parsed.targetHint);
      }
    }
  }

  // Pronoun follow-up: the user didn't name anyone, but we have a carry-over
  // target from the previous turn. Use it.
  if (!targetEmail && parse.data.contextTargetEmail) {
    targetEmail = parse.data.contextTargetEmail;
    console.log("[query] using contextTargetEmail", targetEmail);
  }

  // === Branch: no resolution AND no candidates ===
  // Let the assistant handle it conversationally (ask who, etc.) rather than
  // returning a canned "não achei" — assuming we have OpenAI and a question
  // to work with. Otherwise fall back to the canned error.
  if (!targetEmail && candidates.length === 0) {
    if (parse.data.question && openaiEnabled) {
      const aiContext = {
        now: new Date().toISOString(),
        note: "Nenhuma pessoa identificada na mensagem.",
      };
      const reply = await answerQuestion(
        parse.data.question,
        aiContext,
        history,
      ).catch((err) => {
        console.error("[query] answerQuestion (no-target) failed", err);
        return "Sobre quem você quer saber? Pode passar o nome ou o email.";
      });
      res.json({ reply, facts: null, target: null, candidates: [] });
      return;
    }
    res.json({
      reply: displayHint
        ? `Não achei "${displayHint}" no Workspace.`
        : "Não consegui identificar sobre quem você está perguntando.",
      facts: null,
      target: null,
      candidates: [],
    });
    return;
  }

  // === Branch: candidates but no resolution ===
  // Hand the list to the assistant; let it phrase a disambiguation question.
  if (!targetEmail && candidates.length > 0) {
    console.log("[query] ambiguous, candidates=", candidates.length);
    if (parse.data.question && openaiEnabled) {
      const aiContext = {
        now: new Date().toISOString(),
        candidates: candidates.slice(0, 6),
        hint: displayHint,
      };
      const reply = await answerQuestion(
        parse.data.question,
        aiContext,
        history,
      ).catch((err) => {
        console.error("[query] answerQuestion (candidates) failed", err);
        return `Encontrei ${candidates.length} pessoas com esse nome. Pode ser mais específico?`;
      });
      res.json({ reply, facts: null, target: null, candidates });
      return;
    }
    // Non-AI path: list them in plain text.
    const list = candidates
      .slice(0, 6)
      .map((c, i) => `${i + 1}. ${c.name ?? c.email} (${c.email})`)
      .join("\n");
    res.json({
      reply: `Encontrei mais de uma pessoa. Quem:\n${list}`,
      facts: null,
      target: null,
      candidates,
    });
    return;
  }

  // targetEmail is non-null past this point.
  const targetEmailResolved = targetEmail!;
  console.log(
    "[query] resolved target=",
    targetEmailResolved,
    "in",
    Date.now() - t0,
    "ms",
  );

  const [presence, meeting] = await Promise.all([
    presenceForEmail(targetEmailResolved),
    currentMeeting(asker, targetEmailResolved).catch((err) => {
      console.error("calendar lookup failed", err);
      return { busy: false } as const;
    }),
  ]);

  const workStart = parse.data.workStartHour ?? 9;
  const workEnd = parse.data.workEndHour ?? 18;
  const outsideWorkingHours = isOutsideWorkingHours(
    new Date(),
    workStart,
    workEnd,
  );

  // Always compute a suggested slot — even when the target is currently
  // free, the widget needs SOMETHING to anchor the agenda preview and a
  // future window the asker might want to schedule into.
  const suggestedSlot = await nextFreeSlot(asker, targetEmailResolved, {
    workStartHour: workStart,
    workEndHour: workEnd,
  }).catch((err) => {
    console.error("freebusy lookup failed", err);
    return null;
  });

  const facts = {
    targetEmail: targetEmailResolved,
    online: presence.online,
    lastActivityAt: presence.lastActivityAt,
    meeting,
    suggestedSlot,
    outsideWorkingHours,
    workingHours: { start: workStart, end: workEnd },
  };

  // Reply: free-form question → OpenAI with history + wider event window.
  // Otherwise the deterministic template (widget path).
  let reply: string;
  if (parse.data.question && openaiEnabled) {
    const wideEvents: CalendarEventLite[] = await eventsAround(
      asker,
      targetEmailResolved,
      new Date(),
      24 * 60 * 60 * 1000,
    ).catch(() => [] as CalendarEventLite[]);
    const aiContext = {
      now: new Date().toISOString(),
      target: targetEmailResolved,
      currentlyBusy: facts.meeting.busy
        ? {
            kind: facts.meeting.kind,
            title: facts.meeting.title,
            endsAt: facts.meeting.endsAt.toISOString(),
          }
        : false,
      outsideWorkingHours: facts.outsideWorkingHours,
      workingHours: facts.workingHours,
      suggestedSlot: facts.suggestedSlot
        ? {
            start: facts.suggestedSlot.start.toISOString(),
            end: facts.suggestedSlot.end.toISOString(),
          }
        : null,
      events: wideEvents,
    };
    reply = await answerQuestion(
      parse.data.question,
      aiContext,
      history,
    ).catch((err) => {
      console.error("answerQuestion failed", err);
      return templateStatusReply(facts);
    });
  } else {
    reply = templateStatusReply(facts);
  }

  res.json({
    reply,
    target: { email: targetEmailResolved, name: displayHint },
    candidates: [],
    facts: {
      ...facts,
      lastActivityAt: facts.lastActivityAt?.toISOString() ?? null,
      meeting: facts.meeting.busy
        ? { ...facts.meeting, endsAt: facts.meeting.endsAt.toISOString() }
        : facts.meeting,
      suggestedSlot: facts.suggestedSlot
        ? {
            start: facts.suggestedSlot.start.toISOString(),
            end: facts.suggestedSlot.end.toISOString(),
          }
        : null,
      outsideWorkingHours: facts.outsideWorkingHours,
      workingHours: facts.workingHours,
      eventsAround: facts.suggestedSlot
        ? await eventsAround(
            asker,
            targetEmailResolved,
            facts.suggestedSlot.start,
          ).catch(() => [])
        : [],
      meetingsToday: await meetingsTodayCount(
        asker,
        targetEmailResolved,
        facts.suggestedSlot?.start ?? new Date(),
      ).catch(() => null),
    },
  });
});

export default router;
