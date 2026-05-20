/// <reference types="chrome" />
import { apiFetch, clearSession, setSession } from "./api.js";
import { GOOGLE_CLIENT_ID } from "./config.js";

// === OAuth flow ===
const SCOPES = [
  "openid",
  "email",
  "profile",
  // calendar (full) lets us create events with Meet links via /schedule.
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/directory.readonly",
];

async function signIn(): Promise<{ email: string; name: string | null }> {
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error("Login cancelado.");

  const code = new URL(redirect).searchParams.get("code");
  if (!code) throw new Error("Sem code na resposta do Google.");

  const { session, user } = await apiFetch<{
    session: string;
    user: { id: number; email: string; name: string | null };
  }>("/auth/google/callback", {
    method: "POST",
    body: JSON.stringify({ code }),
  });

  await setSession(session);
  await chrome.storage.local.set({ user });
  return { email: user.email, name: user.name };
}

// === Heartbeat ===
const HEARTBEAT_MIN_INTERVAL_MS = 30_000;
let lastHeartbeatAt = 0;

async function maybeHeartbeat(source: string): Promise<void> {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  try {
    await apiFetch("/heartbeat", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
  } catch (err) {
    console.warn("heartbeat failed", err);
  }
}

// === Message dispatch ===
type Msg =
  | { type: "activity"; source?: string }
  | { type: "signIn" }
  | { type: "signOut" }
  | {
      type: "query";
      question?: string;
      targetEmail?: string;
      targetName?: string;
    }
  | {
      type: "schedule";
      targetEmail: string;
      start: string;
      end: string;
      title: string;
    };

chrome.runtime.onMessage.addListener(
  (msg: Msg, _sender, sendResponse: (r: unknown) => void) => {
    (async () => {
      switch (msg.type) {
        case "activity":
          await maybeHeartbeat(msg.source ?? "tab");
          return { ok: true };
        case "signIn":
          return await signIn();
        case "signOut":
          await clearSession();
          return { ok: true };
        case "query":
          return await apiFetch<{ reply: string; facts: unknown }>("/query", {
            method: "POST",
            body: JSON.stringify({
              question: msg.question,
              targetEmail: msg.targetEmail,
              targetName: msg.targetName,
            }),
          });
        case "schedule":
          return await apiFetch<{
            htmlLink: string;
            meetLink: string | null;
          }>("/schedule", {
            method: "POST",
            body: JSON.stringify({
              targetEmail: msg.targetEmail,
              start: msg.start,
              end: msg.end,
              title: msg.title,
            }),
          });
      }
    })()
      .then((r) => sendResponse({ ok: true, data: r }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the channel open for async response
  },
);
