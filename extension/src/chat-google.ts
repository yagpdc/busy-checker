/// <reference types="chrome" />
// Runs only on chat.google.com. Detects open DMs, extracts the participant
// name from <title>, injects a floating widget that asks the backend
// whether the person is available.

const WIDGET_ID = "busy-checker-widget";

// === URL / title watcher ===
let lastKey: string | null = null;

function currentConversationName(): string | null {
  // Google Chat URLs vary: /dm/<id>, /room/<id>, /app/chat/<id> (newer
  // unified format that doesn't distinguish DM vs space in the path).
  // Detect via <title> instead: when a conversation is open, it becomes
  // "<Name|Space> - Google Chat". When nothing is open, just "Google Chat".
  const title = document.title;
  if (!title || title.trim() === "Google Chat") return null;
  let name = title.replace(/\s*[-|·]\s*Google Chat\s*$/i, "").trim();
  // Strip leading unread-count prefix like "(3) " that Chat adds.
  name = name.replace(/^\(\d+\)\s*/, "");
  if (!name || name.toLowerCase() === "google chat") return null;
  // Skip group spaces — they have multiple members and our backend resolves
  // a single name to a single user. Heuristic: spaces often have a leading
  // # in Chat's UI, or the title contains "people"/"membros".
  if (/^#/.test(name)) return null;
  if (/\b(people|membros|members|participantes)\b/i.test(name)) return null;
  return name;
}

function reactToState(): void {
  const name = currentConversationName();
  const key = name ? `${location.pathname}::${name}` : null;
  if (key === lastKey) return;
  lastKey = key;

  removeWidget();
  if (name) {
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
  document.body.appendChild(host);

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
    setReply(`não rolou: ${(err as Error).message}`, "error");
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
