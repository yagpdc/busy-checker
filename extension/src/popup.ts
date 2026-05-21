/// <reference types="chrome" />
import { DEFAULT_SETTINGS, getSettings, setSettings } from "./settings.js";

type BgResponse<T> = { ok: true; data: T } | { ok: false; error: string };

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: BgResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? "unknown_error"));
    });
  });
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// === User / auth ===
async function refreshUser(): Promise<void> {
  const { user, session } = await chrome.storage.local.get(["user", "session"]);
  const emailEl = $<HTMLSpanElement>("user-email");
  const inBtn = $<HTMLButtonElement>("sign-in");
  const outBtn = $<HTMLButtonElement>("sign-out");
  if (session && user) {
    const u = user as { email: string };
    emailEl.textContent = u.email;
    inBtn.hidden = true;
    outBtn.hidden = false;
    setGreeting(u.email);
  } else {
    emailEl.textContent = "";
    inBtn.hidden = false;
    outBtn.hidden = true;
    setGreeting(null);
  }
}

// === Greeting ===
function setGreeting(email: string | null): void {
  const el = $<HTMLParagraphElement>("greeting-line");
  const hour = new Date().getHours();
  const period =
    hour < 5 ? "Boa noite" : hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  if (!email) {
    el.textContent = `${period}`;
    return;
  }
  // First name from the local-part: "yago.santos" → "Yago"
  const local = email.split("@")[0] ?? "";
  const firstChunk = local.split(/[._-]/)[0] ?? local;
  const name = firstChunk
    ? firstChunk.charAt(0).toUpperCase() + firstChunk.slice(1)
    : "";
  el.textContent = name ? `${period}, ${name}` : period;
}

// === Error display ===
function showError(msg: string): void {
  const el = $<HTMLParagraphElement>("error");
  el.textContent = msg;
  el.hidden = false;
}

function clearError(): void {
  $<HTMLParagraphElement>("error").hidden = true;
}

// === View routing (home ↔ settings) ===
function showView(view: "home" | "settings"): void {
  $<HTMLElement>("view-home").hidden = view !== "home";
  $<HTMLElement>("view-settings").hidden = view !== "settings";
}

$<HTMLButtonElement>("open-settings").addEventListener("click", () => {
  showView("settings");
});
$<HTMLButtonElement>("close-settings").addEventListener("click", () => {
  showView("home");
});

// === Auth buttons ===
$<HTMLButtonElement>("sign-in").addEventListener("click", async () => {
  clearError();
  try {
    await send<{ email: string }>({ type: "signIn" });
    await refreshUser();
  } catch (err) {
    showError((err as Error).message);
  }
});

$<HTMLButtonElement>("sign-out").addEventListener("click", async () => {
  await send({ type: "signOut" });
  await refreshUser();
});

// === Ask flow ===
async function runQuery(q: string): Promise<void> {
  clearError();
  if (!q) return;
  // Input strategy:
  //  - contains '@' → treat as email
  //  - looks like a plain name (no spaces fancy chars) → send as targetName
  //    so the backend resolves via local users / Workspace directory
  //  - everything else → send as free-text question (needs OpenAI)
  const emailMatch = q.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  let payload: {
    type: "query";
    targetEmail?: string;
    targetName?: string;
    question?: string;
  };
  if (emailMatch) {
    payload = { type: "query", targetEmail: emailMatch[0] };
  } else if (/^[\p{L}\s.'-]{2,80}$/u.test(q)) {
    payload = { type: "query", targetName: q };
  } else {
    payload = { type: "query", question: q };
  }
  try {
    const data = await send<{ reply: string; facts: unknown }>(payload);
    $<HTMLParagraphElement>("reply").textContent = data.reply;
    $<HTMLPreElement>("facts").textContent = JSON.stringify(data.facts, null, 2);
    $<HTMLElement>("result").hidden = false;
  } catch (err) {
    showError((err as Error).message);
  }
}

$<HTMLButtonElement>("ask").addEventListener("click", () => {
  const q = $<HTMLTextAreaElement>("question").value.trim();
  void runQuery(q);
});

$<HTMLTextAreaElement>("question").addEventListener("keydown", (ev) => {
  // Enter submits; Shift+Enter inserts newline (textarea default).
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    const q = (ev.currentTarget as HTMLTextAreaElement).value.trim();
    void runQuery(q);
  }
});

// === Suggestion chips ===
// Two chips are starters (focus + prefill the box); one is a full question
// the user can fire immediately. Treat data-q ending with " " as a starter.
document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const q = chip.dataset.q ?? "";
    const ta = $<HTMLTextAreaElement>("question");
    ta.value = q;
    ta.focus();
    // Place cursor at end so the user can complete the prefilled fragment.
    ta.setSelectionRange(q.length, q.length);
    if (!q.endsWith(" ") && !q.endsWith("?")) return;
    if (q.endsWith("?")) {
      void runQuery(q.trim());
    }
  });
});

// === Settings ===
async function loadSettings(): Promise<void> {
  const s = await getSettings();
  $<HTMLInputElement>("work-start").value = String(s.workStartHour);
  $<HTMLInputElement>("work-end").value = String(s.workEndHour);
  $<HTMLInputElement>("event-color").value = s.eventColor;
  $<HTMLInputElement>("widget-enabled").checked = s.widgetEnabled;
}

// Widget toggle persists immediately — it's a binary action that doesn't
// share state with the rest of the form. The content script listens to
// storage.onChanged and reacts live without a page reload.
$<HTMLInputElement>("widget-enabled").addEventListener("change", async (ev) => {
  const enabled = (ev.currentTarget as HTMLInputElement).checked;
  const current = await getSettings().catch(() => DEFAULT_SETTINGS);
  await setSettings({ ...current, widgetEnabled: enabled });
});

$<HTMLButtonElement>("save-settings").addEventListener("click", async () => {
  const ws = parseInt($<HTMLInputElement>("work-start").value, 10);
  const we = parseInt($<HTMLInputElement>("work-end").value, 10);
  const color = $<HTMLInputElement>("event-color").value;
  const widgetEnabled = $<HTMLInputElement>("widget-enabled").checked;
  const msg = $<HTMLParagraphElement>("settings-msg");
  msg.hidden = false;
  if (
    Number.isNaN(ws) ||
    Number.isNaN(we) ||
    ws < 0 ||
    ws > 23 ||
    we < 1 ||
    we > 24 ||
    ws >= we
  ) {
    msg.dataset.error = "true";
    msg.textContent = "Início < fim, 0-24h.";
    return;
  }
  delete msg.dataset.error;
  await setSettings({
    workStartHour: ws,
    workEndHour: we,
    eventColor: color,
    widgetEnabled,
  });
  msg.textContent = "Salvo.";
});

// === Bootstrap ===
refreshUser();
loadSettings().catch(() => {
  $<HTMLInputElement>("work-start").value = String(DEFAULT_SETTINGS.workStartHour);
  $<HTMLInputElement>("work-end").value = String(DEFAULT_SETTINGS.workEndHour);
  $<HTMLInputElement>("event-color").value = DEFAULT_SETTINGS.eventColor;
  $<HTMLInputElement>("widget-enabled").checked = DEFAULT_SETTINGS.widgetEnabled;
});
