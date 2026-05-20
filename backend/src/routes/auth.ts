import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db.js";
import { oauthClient } from "../services/google.js";
import { issueSession } from "../middleware/session.js";

const router = Router();

const callbackBody = z.object({
  code: z.string().min(1),
});

/**
 * Extension exchanges the auth code it got from launchWebAuthFlow.
 * We swap it for tokens (including a refresh token), persist, and
 * return our own session JWT.
 */
router.post("/google/callback", async (req, res) => {
  const parse = callbackBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "bad_request", details: parse.error.flatten() });
    return;
  }

  const client = oauthClient();
  let tokens;
  try {
    ({ tokens } = await client.getToken(parse.data.code));
  } catch (err) {
    console.error("token exchange failed", err);
    res.status(400).json({ error: "code_exchange_failed" });
    return;
  }

  if (!tokens.id_token) {
    res.status(400).json({ error: "missing_id_token" });
    return;
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    res.status(400).json({ error: "invalid_id_token" });
    return;
  }

  if (config.google.allowedHd && payload.hd !== config.google.allowedHd) {
    res.status(403).json({ error: "domain_not_allowed" });
    return;
  }

  if (!tokens.refresh_token) {
    // Happens on re-consent without prompt=consent. Tell the extension to retry.
    res.status(400).json({ error: "missing_refresh_token" });
    return;
  }

  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (google_sub, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id`,
    [payload.sub, payload.email, payload.name ?? null],
  );
  const userId = rows[0].id;

  await query(
    `INSERT INTO oauth_tokens (user_id, refresh_token, access_token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET refresh_token = EXCLUDED.refresh_token,
           access_token = EXCLUDED.access_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [
      userId,
      tokens.refresh_token,
      tokens.access_token ?? null,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    ],
  );

  const session = issueSession({ userId, email: payload.email });
  res.json({
    session,
    user: { id: userId, email: payload.email, name: payload.name ?? null },
  });
});

export default router;
