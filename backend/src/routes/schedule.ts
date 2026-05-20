import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import { scheduleMeeting } from "../services/calendar.js";

const router = Router();

const body = z.object({
  targetEmail: z.string().email(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  title: z.string().min(1).max(200),
});

router.post("/", requireSession, async (req, res) => {
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "bad_request", details: parse.error.flatten() });
    return;
  }
  const asker = await clientForUser(req.session!.userId);
  try {
    const result = await scheduleMeeting(
      asker,
      parse.data.targetEmail,
      new Date(parse.data.start),
      new Date(parse.data.end),
      parse.data.title,
    );
    res.json(result);
  } catch (err) {
    console.error("schedule failed", err);
    res
      .status(500)
      .json({ error: "schedule_failed", message: (err as Error).message });
  }
});

export default router;
