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

// === Chat state (persisted in chrome.storage.session) ===
type Msg = { role: "user" | "assistant"; content: string };
type ChatState = {
  messages: Msg[];
  // Currently-resolved person — used for pronoun follow-ups ("e amanhã?").
  // Cleared when the user explicitly switches targets.
  target: { email: string; name: string | null } | null;
};

let chatState: ChatState = { messages: [], target: null };

async function loadChatState(): Promise<void> {
  const data = await chrome.storage.session
    .get(["chatMessages", "chatTarget"])
    .catch(() => ({}));
  const messages = Array.isArray((data as { chatMessages?: unknown }).chatMessages)
    ? ((data as { chatMessages: Msg[] }).chatMessages.filter(
        (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      ))
    : [];
  const target = ((data as { chatTarget?: unknown }).chatTarget ?? null) as
    | ChatState["target"]
    | null;
  chatState = { messages, target };
  renderThread();
}

async function persistChatState(): Promise<void> {
  await chrome.storage.session
    .set({ chatMessages: chatState.messages, chatTarget: chatState.target })
    .catch(() => undefined);
}

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
    hour < 5
      ? "Boa noite"
      : hour < 12
      ? "Bom dia"
      : hour < 18
      ? "Boa tarde"
      : "Boa noite";
  if (!email) {
    el.textContent = `${period}`;
    return;
  }
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

// === Thread rendering ===
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function appendUserBubble(text: string): void {
  const thread = $<HTMLElement>("chat-thread");
  const node = el("div", "msg msg-user");
  node.textContent = text;
  thread.appendChild(node);
  thread.scrollTop = thread.scrollHeight;
}

function appendAssistantBubble(text: string): void {
  const thread = $<HTMLElement>("chat-thread");
  const wrap = el("div", "msg msg-assistant");
  const kanji = el("span", "msg-kanji");
  kanji.textContent = "時";
  const bubble = el("div", "msg-bubble");
  bubble.textContent = text;
  wrap.appendChild(kanji);
  wrap.appendChild(bubble);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

function appendLoadingBubble(): HTMLElement {
  const thread = $<HTMLElement>("chat-thread");
  const wrap = el("div", "msg msg-loading");
  wrap.dataset.loading = "true";
  const kanji = el("span", "msg-kanji");
  kanji.textContent = "時";
  const text = el("span", "loading-text");
  text.textContent = pickLoadingPhrase();
  const spinner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  spinner.setAttribute("class", "loading-spinner");
  spinner.setAttribute("viewBox", "0 0 24 24");
  spinner.setAttribute("fill", "none");
  spinner.setAttribute("stroke", "currentColor");
  spinner.setAttribute("stroke-width", "2");
  spinner.setAttribute("stroke-linecap", "round");
  spinner.setAttribute("stroke-linejoin", "round");
  spinner.innerHTML =
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>';
  wrap.appendChild(kanji);
  wrap.appendChild(text);
  wrap.appendChild(spinner);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

function renderThread(): void {
  const thread = $<HTMLElement>("chat-thread");
  const controls = $<HTMLElement>("thread-controls");
  const greeting = $<HTMLElement>("greeting-block");
  const contextEl = $<HTMLSpanElement>("thread-context");

  thread.replaceChildren();
  if (chatState.messages.length === 0) {
    thread.hidden = true;
    controls.hidden = true;
    greeting.dataset.active = "false";
    return;
  }
  greeting.dataset.active = "true";
  thread.hidden = false;
  controls.hidden = false;
  for (const m of chatState.messages) {
    if (m.role === "user") appendUserBubble(m.content);
    else appendAssistantBubble(m.content);
  }
  contextEl.textContent = chatState.target
    ? `Falando sobre: ${chatState.target.name ?? chatState.target.email}`
    : "";
}

// === Ask flow ===
async function runQuery(text: string): Promise<void> {
  clearError();
  if (!text) return;
  const question = text;

  // Append user bubble + persist
  chatState.messages.push({ role: "user", content: question });
  if (chatState.messages.length === 1) {
    $<HTMLElement>("greeting-block").dataset.active = "true";
    $<HTMLElement>("chat-thread").hidden = false;
    $<HTMLElement>("thread-controls").hidden = false;
  }
  appendUserBubble(question);
  await persistChatState();

  // Clear the input, disable submit
  const ta = $<HTMLTextAreaElement>("question");
  ta.value = "";
  $<HTMLButtonElement>("ask").disabled = true;

  // Show loading bubble
  const loadingNode = appendLoadingBubble();

  try {
    // The history we send is everything EXCEPT the latest user message —
    // the backend appends that itself as the OpenAI "current question".
    const history = chatState.messages.slice(0, -1);
    const payload: {
      type: "query";
      question: string;
      messages: Msg[];
      contextTargetEmail?: string;
    } = {
      type: "query",
      question,
      messages: history,
    };
    if (chatState.target?.email) {
      payload.contextTargetEmail = chatState.target.email;
    }
    const data = await send<{
      reply: string;
      target: { email: string; name: string | null } | null;
      candidates: Array<{ email: string; name: string | null }>;
      facts: unknown;
    }>(payload);

    loadingNode.remove();
    appendAssistantBubble(data.reply);
    chatState.messages.push({ role: "assistant", content: data.reply });

    // Carry-over target. Backend returns the resolved person (if any) so
    // the next pronoun follow-up has someone to refer to. When the turn
    // was a disambiguation (candidates), target is null — keep prior one.
    if (data.target) {
      chatState.target = data.target;
    }
    $<HTMLSpanElement>("thread-context").textContent = chatState.target
      ? `Falando sobre: ${chatState.target.name ?? chatState.target.email}`
      : "";

    await persistChatState();
  } catch (err) {
    loadingNode.remove();
    const msg = (err as Error).message;
    appendAssistantBubble(`Erro: ${msg}`);
    chatState.messages.push({ role: "assistant", content: `Erro: ${msg}` });
    await persistChatState();
  } finally {
    $<HTMLButtonElement>("ask").disabled = false;
    ta.focus();
  }
}

$<HTMLButtonElement>("ask").addEventListener("click", () => {
  const q = $<HTMLTextAreaElement>("question").value.trim();
  void runQuery(q);
});

$<HTMLTextAreaElement>("question").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    const q = (ev.currentTarget as HTMLTextAreaElement).value.trim();
    void runQuery(q);
  }
});

// === Clear conversation ===
$<HTMLButtonElement>("clear-chat").addEventListener("click", async () => {
  chatState = { messages: [], target: null };
  await persistChatState();
  renderThread();
  $<HTMLTextAreaElement>("question").focus();
});

// === Settings ===
async function loadSettings(): Promise<void> {
  const s = await getSettings();
  $<HTMLInputElement>("work-start").value = String(s.workStartHour);
  $<HTMLInputElement>("work-end").value = String(s.workEndHour);
  $<HTMLInputElement>("event-color").value = s.eventColor;
  $<HTMLInputElement>("widget-enabled").checked = s.widgetEnabled;
}

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.widgetOpen) {
    const open =
      typeof changes.widgetOpen.newValue === "boolean"
        ? changes.widgetOpen.newValue
        : true;
    $<HTMLInputElement>("widget-open").checked = open;
    updateWidgetOpenHelp(open);
  }
});

// === Update check ===
// Fetched from the backend's /version endpoint. We compare the returned
// `version` against `chrome.runtime.getManifest().version` and surface a
// banner when newer. Click → download + open chrome://extensions + show
// reinstall instructions modal.
async function checkForUpdate(): Promise<void> {
  let info: { version: string; downloadUrl: string } | null = null;
  try {
    const base =
      // Lazy import via global to avoid pulling api.ts here — popup.ts
      // doesn't need authenticated requests for /version.
      "https://services.kipflow.io/busy-checker";
    const res = await fetch(`${base}/version`, { cache: "no-cache" });
    if (!res.ok) return;
    info = (await res.json()) as { version: string; downloadUrl: string };
  } catch {
    return; // offline, backend down — ignore silently
  }
  const installed = chrome.runtime.getManifest().version;
  if (!info || isUpToDate(installed, info.version)) return;

  $<HTMLSpanElement>("update-banner-version").textContent = `v${installed} → v${info.version}`;
  $<HTMLElement>("update-banner").hidden = false;

  const btn = $<HTMLButtonElement>("update-now");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Baixando…";
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.downloads.download(
          { url: info!.downloadUrl, filename: "toki-latest.zip" },
          (id) => {
            if (chrome.runtime.lastError || !id) {
              reject(
                new Error(chrome.runtime.lastError?.message ?? "download_failed"),
              );
            } else resolve();
          },
        );
      });
      chrome.tabs.create({ url: "chrome://extensions" });
      $<HTMLElement>("update-modal").hidden = false;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Atualizar";
      showError(`Não consegui baixar: ${(err as Error).message}`);
    }
  };
}

// Semver-lite comparison good enough for our X.Y.Z extension versions.
function isUpToDate(installed: string, latest: string): boolean {
  const i = installed.split(".").map((n) => parseInt(n, 10) || 0);
  const l = latest.split(".").map((n) => parseInt(n, 10) || 0);
  for (let k = 0; k < Math.max(i.length, l.length); k++) {
    const a = i[k] ?? 0;
    const b = l[k] ?? 0;
    if (a < b) return false;
    if (a > b) return true; // local newer than server, treat as up-to-date
  }
  return true;
}

function closeUpdateModal(): void {
  $<HTMLElement>("update-modal").hidden = true;
}

$<HTMLButtonElement>("update-modal-close").addEventListener(
  "click",
  closeUpdateModal,
);
// Click on the dark backdrop (anywhere outside the card) also closes.
$<HTMLElement>("update-modal").addEventListener("click", (ev) => {
  if (ev.target === ev.currentTarget) closeUpdateModal();
});
// Esc closes too.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$<HTMLElement>("update-modal").hidden) {
    closeUpdateModal();
  }
});

// === Bootstrap ===
refreshUser();
loadChatState();
checkForUpdate();
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
