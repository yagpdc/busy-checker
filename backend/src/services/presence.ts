import { query } from "../db.js";
import { config } from "../config.js";

export async function recordHeartbeat(
  userId: number,
  source: string | null,
): Promise<void> {
  await query(
    `INSERT INTO presence_heartbeats (user_id, last_activity_at, source)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (user_id) DO UPDATE
       SET last_activity_at = EXCLUDED.last_activity_at,
           source = EXCLUDED.source`,
    [userId, source],
  );
}

export type Presence = {
  online: boolean;
  lastActivityAt: Date | null;
};

export async function presenceForEmail(email: string): Promise<Presence> {
  const { rows } = await query<{ last_activity_at: Date }>(
    `SELECT p.last_activity_at
       FROM users u
       JOIN presence_heartbeats p ON p.user_id = u.id
      WHERE u.email = $1`,
    [email],
  );
  if (rows.length === 0) return { online: false, lastActivityAt: null };
  const lastActivityAt = rows[0].last_activity_at;
  const ageSec = (Date.now() - lastActivityAt.getTime()) / 1000;
  return { online: ageSec <= config.presenceWindowSec, lastActivityAt };
}

export async function userIdForEmail(email: string): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  return rows[0]?.id ?? null;
}

/**
 * Best-effort: find a registered user whose display name loosely matches `hint`.
 * Returns null if 0 or >1 matches (ambiguous → caller should ask for clarification).
 */
export async function emailForNameHint(
  hint: string,
): Promise<string | null> {
  const normalized = hint.trim().toLowerCase();
  if (!normalized) return null;
  const { rows } = await query<{ email: string }>(
    `SELECT email FROM users
      WHERE LOWER(name) = $1
         OR LOWER(name) LIKE $2
      LIMIT 2`,
    [normalized, `%${normalized}%`],
  );
  if (rows.length !== 1) return null;
  return rows[0].email;
}
