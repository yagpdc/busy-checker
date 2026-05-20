/// <reference types="chrome" />
// Runs only on chat.google.com. Detects open DMs, extracts the participant
// name from <title>, injects a floating widget that asks the backend
// whether the person is available.

const WIDGET_ID = "busy-checker-widget";

// === URL / title watcher ===
let lastKey: string | null = null;

function currentConversationName(): string | null {
  // Detect via <title>. Observed formats across PWA / web app:
  //   "<Name> - Google Chat"
  //   "<Name> - Chat"
  //   "(3) <Name> - Chat"
  //   "Google Chat" / "Chat" (nothing open)
  // \p{Pd} = any Unicode dash (hyphen, en-dash, em-dash, etc).
  const title = document.title;
  if (!title) return null;
  const stripped = title.replace(/^\(\d+\)\s*/, "");
  const m = stripped.match(/^(.*?)\s+[\p{Pd}|·]\s+(Google\s+)?Chat\s*$/u);
  if (!m) {
    console.debug("[busy-checker] title not in conversation form:", title);
    return null;
  }
  const name = m[1].trim();
  if (!name) return null;
  if (/^(google\s+)?chat$/i.test(name)) return null;
  if (/^#/.test(name)) return null;
  if (/\b(people|membros|members|participantes)\b/i.test(name)) return null;
  console.debug("[busy-checker] detected conversation:", name);
  return name;
}

function reactToState(): void {
  const name = currentConversationName();
  const key = name ? `${location.pathname}::${name}` : null;
  const widgetExists = !!document.getElementById(WIDGET_ID);

  // Skip only if the state didn't change AND the widget is where we expect.
  // Google Chat aggressively re-renders body on DM switch and can yank our
  // node out — when that happens we need to recreate even if state is same.
  if (key === lastKey && (key === null || widgetExists)) return;

  lastKey = key;
  removeWidget();
  if (name) {
    console.debug("[busy-checker] creating widget for:", name);
    openWidget(name);
  }
}

const obs = new MutationObserver(reactToState);
obs.observe(document, { subtree: true, childList: true, characterData: true });
window.addEventListener("popstate", reactToState);
// Tick once to catch initial state, then periodically as a safety net in case
// the SPA mutates in ways the observer doesn't surface fast enough.
reactToState();
setInterval(reactToState, 2000);

// === Widget ===
function removeWidget(): void {
  document.getElementById(WIDGET_ID)?.remove();
}

function openWidget(name: string): void {
  const host = document.createElement("div");
  host.id = WIDGET_ID;
  host.style.cssText =
    "position:fixed;bottom:24px;right:24px;z-index:2147483647;all:initial;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = WIDGET_HTML;
  // Attach to documentElement (<html>) — survives most body re-renders.
  // Falls back to body if for some reason html isn't writable.
  (document.documentElement || document.body).appendChild(host);

  const $ = (sel: string) => shadow.querySelector(sel) as HTMLElement;
  ($("#bc-name") as HTMLElement).textContent = name;
  $("#bc-close").addEventListener("click", removeWidget);

  void askBackend(name, shadow);
}

async function askBackend(name: string, shadow: ShadowRoot): Promise<void> {
  const setReply = (text: string, state: "thinking" | "ok" | "error") => {
    const reply = shadow.querySelector("#bc-reply") as HTMLElement;
    const root = shadow.querySelector("#bc-root") as HTMLElement;
    reply.textContent = text;
    root.dataset.state = state;
  };

  try {
    const res = await chrome.runtime.sendMessage({
      type: "query",
      targetName: name,
    });
    if (!res?.ok) throw new Error(res?.error ?? "unknown_error");
    setReply(res.data.reply, "ok");
  } catch (err) {
    const msg = (err as Error).message;
    // Orphaned script after extension reload — keep quiet, user just needs F5.
    if (msg.includes("Extension context invalidated")) return;
    setReply(`não rolou: ${msg}`, "error");
  }
}

// Styles + structure live here so the file is self-contained and the SW
// doesn't have to inject a separate stylesheet.
const WIDGET_HTML = `
<style>
  :host { all: initial; }
  #bc-root {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #ffffff;
    color: #1f2328;
    border: 1px solid #d0d7de;
    border-radius: 12px;
    padding: 12px 14px;
    width: 260px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    display: grid;
    grid-template-columns: 36px 1fr auto;
    gap: 10px;
    align-items: center;
  }
  #bc-creature {
    font-size: 28px;
    line-height: 1;
    display: inline-block;
    transform-origin: 50% 70%;
  }
  #bc-root[data-state="thinking"] #bc-creature {
    animation: bc-wobble 0.9s ease-in-out infinite;
  }
  @keyframes bc-wobble {
    0%, 100% { transform: rotate(-8deg); }
    50%      { transform: rotate(8deg); }
  }
  #bc-text { min-width: 0; }
  #bc-name {
    font-size: 12px;
    color: #57606a;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #bc-reply {
    font-size: 14px;
    line-height: 1.35;
    margin-top: 2px;
  }
  #bc-root[data-state="thinking"] #bc-reply::after {
    content: "…";
    display: inline-block;
    animation: bc-dots 1.2s steps(4, end) infinite;
    width: 1.2em;
    text-align: left;
    overflow: hidden;
    vertical-align: bottom;
  }
  @keyframes bc-dots {
    0%   { content: ""; }
    25%  { content: "."; }
    50%  { content: ".."; }
    75%  { content: "..."; }
  }
  #bc-root[data-state="error"] { border-color: #f1b8b8; background: #fff5f5; }
  #bc-close {
    background: none;
    border: 0;
    font-size: 16px;
    color: #57606a;
    cursor: pointer;
    line-height: 1;
    padding: 4px;
    border-radius: 6px;
  }
  #bc-close:hover { background: #eaeef2; }
</style>
<div id="bc-root" data-state="thinking">
  <span id="bc-creature" aria-hidden="true">🐱</span>
  <div id="bc-text">
    <div id="bc-name"></div>
    <div id="bc-reply">pensando</div>
  </div>
  <button id="bc-close" aria-label="fechar">×</button>
</div>
`;
