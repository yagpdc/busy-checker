import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { query } from "../db.js";

export function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  // calendar (full) is a superset of calendar.readonly + lets us create
  // events with Meet links via /schedule.
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/directory.readonly",
];

/**
 * Returns an OAuth2Client already loaded with the user's tokens.
 * Refreshes the access token if needed and persists the new one.
 */
export async function clientForUser(userId: number): Promise<OAuth2Client> {
  const { rows } = await query<{
    refresh_token: string;
    access_token: string | null;
    expires_at: Date | null;
  }>(
    `SELECT refresh_token, access_token, expires_at
     FROM oauth_tokens WHERE user_id = $1`,
    [userId],
  );
  if (rows.length === 0) throw new Error("no_tokens_for_user");
  const row = rows[0];

  const client = oauthClient();
  client.setCredentials({
    refresh_token: row.refresh_token,
    access_token: row.access_token ?? undefined,
    expiry_date: row.expires_at ? row.expires_at.getTime() : undefined,
  });

  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      query(
        `UPDATE oauth_tokens
           SET access_token = $1,
               expires_at = $2,
               refresh_token = COALESCE($3, refresh_token),
               updated_at = NOW()
         WHERE user_id = $4`,
        [
          tokens.access_token,
          tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          tokens.refresh_token ?? null,
          userId,
        ],
      ).catch((err) => console.error("failed to persist refreshed token", err));
    }
  });

  return client;
}
