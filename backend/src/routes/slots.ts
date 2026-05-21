import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import { eventsForDay, nextFreeSlot } from "../services/calendar.js";

const router = Router();

const body = z.object({
  targetEmail: z.string().email(),
  // ISO timestamp — search starts at this moment. Defaults to now.
  after: z.string().datetime().optional(),
  minDurationMin: z.number().int().min(5).max(480).optional(),
  workStartHour: z.number().int().min(0).max(23).optional(),
  workEndHour: z.number().int().min(1).max(24).optional(),
});

router.post("/next", requireSession, async (req, res) => {
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const asker = await clientForUser(req.session!.userId);
  const now = parse.data.after ? new Date(parse.data.after) : new Date();
  try {
    const slot = await nextFreeSlot(
      asker,
      parse.data.targetEmail,
      {
        minDurationMin: parse.data.minDurationMin ?? 30,
        lookAheadDays: 14,
        workStartHour: parse.data.workStartHour ?? 9,
        workEndHour: parse.data.workEndHour ?? 18,
      },
      now,
    );
    const dayEvents = slot
      ? await eventsForDay(asker, parse.data.targetEmail, slot.start).catch(
          () => [],
        )
      : [];
    res.json({
      slot: slot
        ? { start: slot.start.toISOString(), end: slot.end.toISOString() }
        : null,
      dayEvents,
    });
  } catch (err) {
    console.error("slots/next failed", err);
    res
      .status(500)
      .json({ error: "slots_failed", message: (err as Error).message });
  }
});

export default router;
