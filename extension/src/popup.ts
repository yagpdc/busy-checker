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
// Mirrors the widget's loading phrases so the popup feels like the same app.
const LOADING_PHRASES = [
  "時間を整理しています...",
  "Só mais alguns segundos",
  "Carregando o futuro",
  "Harmonizando agendas",
  "Processando eventos",
  "Preparando sua próxima reunião...",
];
function pickLoadingPhrase(): string {
  return LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)];
}

function showLoading(): void {
  const loadingEl = $<HTMLDivElement>("reply-loading");
  const textEl = loadingEl.querySelector(".loading-text") as HTMLSpanElement;
  textEl.textContent = pickLoadingPhrase();
  $<HTMLParagraphElement>("reply").textContent = "";
  $<HTMLParagraphElement>("reply").hidden = true;
  loadingEl.hidden = false;
  $<HTMLElement>("result").hidden = false;
  $<HTMLButtonElement>("ask").disabled = true;
}

function showReply(text: string): void {
  $<HTMLDivElement>("reply-loading").hidden = true;
  const reply = $<HTMLParagraphElement>("reply");
  reply.textContent = text;
  reply.hidden = false;
  $<HTMLElement>("result").hidden = false;
  $<HTMLButtonElement>("ask").disabled = false;
}

function endLoading(): void {
  $<HTMLDivElement>("reply-loading").hidden = true;
  $<HTMLButtonElement>("ask").disabled = false;
}

// Heuristic for splitting input. The naive "matches letter/space regex →
// it's a name" rule misclassifies PT-BR sentences like "o diogo está
// livre" because they only contain letters and spaces — the backend
// then directory-searches the whole sentence and finds nothing. Treat
// anything that looks like a question (punctuation, question word,
// state verb, 5+ words) as a free-form question and let OpenAI parse
// who they're asking about.
const QUESTION_WORDS_RE =
  /\b(quem|onde|quando|como|qual|quanto|por\s+que|porqu[eê]|est[aá]|t[aá]|fica|tem|vai|livre|ocupad[oa]|hora|amanh[aã]|hoje|agora|agenda|reuni[aã]o|meeting)\b/i;

function classifyInput(q: string): {
  type: "query";
  targetEmail?: string;
  targetName?: string;
  question?: string;
} {
  const emailMatch = q.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) return { type: "query", targetEmail: emailMatch[0] };
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const looksLikeQuestion =
    q.includes("?") || wordCount > 4 || QUESTION_WORDS_RE.test(q);
  if (looksLikeQuestion) return { type: "query", question: q };
  if (/^[\p{L}\s.'-]{2,80}$/u.test(q)) return { type: "query", targetName: q };
  return { type: "query", question: q };
}

async function runQuery(q: string): Promise<void> {
  clearError();
  if (!q) return;
  const payload = classifyInput(q);
  showLoading();
  try {
    const data = await send<{ reply: string; facts: unknown }>(payload);
    showReply(data.reply);
  } catch (err) {
    endLoading();
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
// Each chip is a starter: prefill the textarea with a question template,
// focus it, and put the caret where the user should type the person's
// name. data-q is the prefix; optional data-tail is the suffix after
// the name (e.g. "está livre agora?"). No chip auto-submits — the user
// always names someone before sending.
document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const prefix = chip.dataset.q ?? "";
    const tail = chip.dataset.tail ?? "";
    const ta = $<HTMLTextAreaElement>("question");
    ta.value = prefix + tail;
    ta.focus();
    ta.setSelectionRange(prefix.length, prefix.length);
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

// === Home: session-scoped widget open/close switch ===
// Lives in chrome.storage.session (cleared on browser restart). The content
// script writes false when the X is clicked; we write here on toggle.
async function loadWidgetOpen(): Promise<void> {
  const sess = await chrome.storage.session.get("widgetOpen").catch(() => ({}));
  const open =
    typeof (sess as { widgetOpen?: unknown }).widgetOpen === "boolean"
      ? ((sess as { widgetOpen: boolean }).widgetOpen)
      : true;
  $<HTMLInputElement>("widget-open").checked = open;
  updateWidgetOpenHelp(open);
}

function updateWidgetOpenHelp(open: boolean): void {
  const help = $<HTMLSpanElement>("widget-open-help");
  help.textContent = open
    ? "Aberto. Aparece nas DMs."
    : "Fechado. Reabra aqui quando quiser.";
  if (open) delete help.dataset.state;
  else help.dataset.state = "closed";
}

$<HTMLInputElement>("widget-open").addEventListener("change", async (ev) => {
  const open = (ev.currentTarget as HTMLInputElement).checked;
  updateWidgetOpenHelp(open);
  await chrome.storage.session.set({ widgetOpen: open });
});

// Keep popup state in sync if the user closes the widget via the X while
// the popup happens to be open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.widgetOpen) return;
  const open =
    typeof changes.widgetOpen.newValue === "boolean"
      ? changes.widgetOpen.newValue
      : true;
  $<HTMLInputElement>("widget-open").checked = open;
  updateWidgetOpenHelp(open);
});

// === Bootstrap ===
refreshUser();
loadSettings().catch(() => {
  $<HTMLInputElement>("work-start").value = String(DEFAULT_SETTINGS.workStartHour);
  $<HTMLInputElement>("work-end").value = String(DEFAULT_SETTINGS.workEndHour);
  $<HTMLInputElement>("event-color").value = DEFAULT_SETTINGS.eventColor;
  $<HTMLInputElement>("widget-enabled").checked = DEFAULT_SETTINGS.widgetEnabled;
});
loadWidgetOpen().catch(() => {
  $<HTMLInputElement>("widget-open").checked = true;
  updateWidgetOpenHelp(true);
});
