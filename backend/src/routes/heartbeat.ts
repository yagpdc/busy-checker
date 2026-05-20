import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/session.js";
import { recordHeartbeat } from "../services/presence.js";

const router = Router();

const body = z.object({
  source: z.string().max(64).optional(),
});

router.post("/", requireSession, async (req, res) => {
  const parse = body.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  await recordHeartbeat(req.session!.userId, parse.data.source ?? null);
  res.json({ ok: true });
});

export default router;
