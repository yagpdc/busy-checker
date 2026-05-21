import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import {
  currentMeeting,
  eventsForDay,
  nextFreeSlot,
} from "../services/calendar.js";
import { findEmailInDirectory } from "../services/directory.js";
import { emailForNameHint, presenceForEmail } from "../services/presence.js";
import { openaiEnabled, parseQuestion } from "../services/openai.js";
import {
  isOutsideWorkingHours,
  templateStatusReply,
} from "../services/replies.js";

const router = Router();

const body = z.object({
  // At least one of the three must be present. `question` requires OpenAI.
  question: z.string().min(1).max(500).optional(),
  targetEmail: z.string().email().optional(),
  targetName: z.string().min(1).max(120).optional(),
  // Asker-configured working window. Used both to flag "outside hours"
  // status and to constrain suggested slots.
  workStartHour: z.number().int().min(0).max(23).optional(),
  workEndHour: z.number().int().min(1).max(24).optional(),
});

router.post("/", requireSession, async (req, res) => {
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "bad_request" });
    return;
  }

  let targetEmail = parse.data.targetEmail ?? null;
  let displayHint: string | null = parse.data.targetName ?? null;

  // Need the asker client early — directory lookup also goes through it.
  const asker = await clientForUser(req.session!.userId);

  // Resolution priority: explicit email > local users table > Workspace directory.
  async function resolveByHint(hint: string): Promise<string | null> {
    const local = await emailForNameHint(hint);
    if (local) return local;
    return await findEmailInDirectory(asker, hint);
  }

  if (!targetEmail && parse.data.targetName) {
    targetEmail = await resolveByHint(parse.data.targetName);
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
    const parsed = await parseQuestion(parse.data.question);
    targetEmail = parsed.targetEmail;
    displayHint = displayHint ?? parsed.targetHint;
    if (!targetEmail && parsed.targetHint) {
      targetEmail = await resolveByHint(parsed.targetHint);
    }
  }

  if (!targetEmail) {
    res.json({
      reply: displayHint
        ? `Não achei "${displayHint}" no Workspace (nome ambíguo ou não encontrado — tenta com email).`
        : "Não consegui identificar sobre quem você está perguntando.",
      facts: null,
    });
    return;
  }

  const [presence, meeting] = await Promise.all([
    presenceForEmail(targetEmail),
    currentMeeting(asker, targetEmail).catch((err) => {
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

  // Suggest a slot whenever the answer is "not available right now":
  // either actively in a meeting, or outside the asker's working hours.
  const suggestedSlot =
    meeting.busy || outsideWorkingHours
      ? await nextFreeSlot(asker, targetEmail, {
          workStartHour: workStart,
          workEndHour: workEnd,
        }).catch((err) => {
          console.error("freebusy lookup failed", err);
          return null;
        })
      : null;

  // Fetch the target's events for the suggested slot's day (or today if
  // we don't have a suggestion). Empty list if calendar isn't readable.
  const dayAnchor = suggestedSlot ? suggestedSlot.start : new Date();
  const dayEvents = await eventsForDay(asker, targetEmail, dayAnchor).catch(
    (err) => {
      console.error("events list failed", err);
      return [];
    },
  );

  const facts = {
    targetEmail,
    online: presence.online,
    lastActivityAt: presence.lastActivityAt,
    meeting,
    suggestedSlot,
    outsideWorkingHours,
    workingHours: { start: workStart, end: workEnd },
  };

  // Reply text is always built from the template — it's deterministic and
  // doesn't hallucinate times. OpenAI is reserved for parsing free-form
  // questions in `parseQuestion` above.
  const reply = templateStatusReply(facts);

  res.json({
    reply,
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
      dayEvents,
    },
  });
});

export default router;
