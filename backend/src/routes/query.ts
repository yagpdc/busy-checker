import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import { currentMeeting } from "../services/calendar.js";
import { emailForNameHint, presenceForEmail } from "../services/presence.js";
import {
  formatStatusReply,
  openaiEnabled,
  parseQuestion,
  templateStatusReply,
} from "../services/openai.js";

const router = Router();

const body = z.object({
  // At least one of the three must be present. `question` requires OpenAI.
  question: z.string().min(1).max(500).optional(),
  targetEmail: z.string().email().optional(),
  targetName: z.string().min(1).max(120).optional(),
});

router.post("/", requireSession, async (req, res) => {
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "bad_request" });
    return;
  }

  let targetEmail = parse.data.targetEmail ?? null;
  let displayHint: string | null = parse.data.targetName ?? null;

  if (!targetEmail && parse.data.targetName) {
    targetEmail = await emailForNameHint(parse.data.targetName);
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
      targetEmail = await emailForNameHint(parsed.targetHint);
    }
  }

  if (!targetEmail) {
    res.json({
      reply: displayHint
        ? `Não achei "${displayHint}" entre os usuários registrados (precisa ter instalado a extensão, ou passe um email).`
        : "Não consegui identificar sobre quem você está perguntando.",
      facts: null,
    });
    return;
  }

  const asker = await clientForUser(req.session!.userId);

  const [presence, meeting] = await Promise.all([
    presenceForEmail(targetEmail),
    currentMeeting(asker, targetEmail).catch((err) => {
      console.error("calendar lookup failed", err);
      return { busy: false } as const;
    }),
  ]);

  const facts = {
    targetEmail,
    online: presence.online,
    lastActivityAt: presence.lastActivityAt,
    meeting,
  };

  const reply = openaiEnabled
    ? await formatStatusReply(parse.data.question ?? "", facts)
    : templateStatusReply(facts);

  res.json({
    reply,
    facts: {
      ...facts,
      lastActivityAt: facts.lastActivityAt?.toISOString() ?? null,
      meeting: facts.meeting.busy
        ? { ...facts.meeting, endsAt: facts.meeting.endsAt.toISOString() }
        : facts.meeting,
    },
  });
});

export default router;
