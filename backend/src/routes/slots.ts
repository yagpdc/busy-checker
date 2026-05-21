import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { clientForUser } from "../services/google.js";
import {
  eventsAround,
  meetingsTodayCount,
  nextFreeSlot,
} from "../services/calendar.js";

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
  const t0 = Date.now();
  const parse = body.safeParse(req.body);
  if (!parse.success) {
    console.warn("[slots/next] bad_request", parse.error.issues);
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const asker = await clientForUser(req.session!.userId);
  const now = parse.data.after ? new Date(parse.data.after) : new Date();
  console.log(
    "[slots/next] in",
    JSON.stringify({
      target: parse.data.targetEmail,
      after: now.toISOString(),
    }),
  );
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
    const evts = slot
      ? await eventsAround(asker, parse.data.targetEmail, slot.start).catch(() => [])
      : [];
    const meetingsToday = slot
      ? await meetingsTodayCount(asker, parse.data.targetEmail, slot.start).catch(
          () => null,
        )
      : null;
    console.log(
      "[slots/next] out",
      JSON.stringify({
        target: parse.data.targetEmail,
        gotSlot: !!slot,
        slot: slot
          ? { start: slot.start.toISOString(), end: slot.end.toISOString() }
          : null,
        events: evts.length,
        meetingsToday,
        ms: Date.now() - t0,
      }),
    );
    res.json({
      slot: slot
        ? { start: slot.start.toISOString(), end: slot.end.toISOString() }
        : null,
      eventsAround: evts,
      meetingsToday,
    });
  } catch (err) {
    console.error(
      "[slots/next] failed",
      parse.data.targetEmail,
      "after",
      Date.now() - t0,
      "ms:",
      err,
    );
    res
      .status(500)
      .json({ error: "slots_failed", message: (err as Error).message });
  }
});

export default router;
