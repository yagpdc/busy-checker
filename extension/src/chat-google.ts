/// <reference types="chrome" />
// Runs only on chat.google.com. Detects open DMs, extracts the participant
// name from <title>, injects a floating widget that asks the backend
// whether the person is available + offers to schedule the next free slot.

const WIDGET_ID = "busy-checker-widget";

// === URL / title watcher ===
let lastKey: string | null = null;

function currentConversationName(): string | null {
  // Observed title formats:
  //   "<Name> - Google Chat"
  //   "<Name> - Chat"
  //   "(3) <Name> - Chat"
  //   "Google Chat" / "Chat" (nothing open)
  // \p{Pd} = any Unicode dash (hyphen, en-dash, em-dash, etc).
  const title = document.title;
  if (!title) return null;
  const stripped = title.replace(/^\(\d+\)\s*/, "");
  const m = stripped.match(/^(.*?)\s+[\p{Pd}|·]\s+(Google\s+)?Chat\s*$/u);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  if (/^(google\s+)?chat$/i.test(name)) return null;
  if (/^#/.test(name)) return null;
  if (/\b(people|membros|members|participantes)\b/i.test(name)) return null;
  return name;
}

function reactToState(): void {
  const name = currentConversationName();
  const key = name ? `${location.pathname}::${name}` : null;
  const widgetExists = !!document.getElementById(WIDGET_ID);
  if (key === lastKey && (key === null || widgetExists)) return;
  lastKey = key;
  removeWidget();
  if (name) openWidget(name);
}

const obs = new MutationObserver(reactToState);
obs.observe(document, { subtree: true, childList: true, characterData: true });
window.addEventListener("popstate", reactToState);
reactToState();
setInterval(reactToState, 2000);

// === Widget ===
function removeWidget(): void {
  document.getElementById(WIDGET_ID)?.remove();
}

function openWidget(name: string): void {
  const host = document.createElement("div");
  host.id = WIDGET_ID;
  // ORDER MATTERS: all:initial first, then layer positioning on top.
  host.style.cssText =
    "all:initial;position:fixed!important;bottom:24px!important;right:24px!important;z-index:2147483647!important;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = WIDGET_HTML;
  (document.documentElement || document.body).appendChild(host);

  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  ($("#bc-name") as HTMLElement).textContent = name;
  $<HTMLButtonElement>("#bc-close").addEventListener("click", removeWidget);

  void askBackend(name, shadow);
}

type Slot = { start: string; end: string };
type Facts = {
  targetEmail: string;
  online: boolean;
  lastActivityAt: string | null;
  meeting: { busy: false } | { busy: true; title: string | null; endsAt: string };
  suggestedSlot: Slot | null;
};

function formatSlot(slot: Slot): string {
  const start = new Date(slot.start);
  const now = new Date();
  const tz = "America/Sao_Paulo";
  const sameDay =
    start.toLocaleDateString("pt-BR", { timeZone: tz }) ===
    now.toLocaleDateString("pt-BR", { timeZone: tz });
  const time = start.toLocaleTimeString("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `hoje às ${time}`;
  return (
    start.toLocaleDateString("pt-BR", {
      timeZone: tz,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    }) + ` às ${time}`
  );
}

async function askBackend(name: string, shadow: ShadowRoot): Promise<void> {
  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  const root = $("#bc-root") as HTMLElement;
  const reply = $("#bc-reply") as HTMLElement;
  const statusText = $("#bc-status-text") as HTMLElement;
  const slotEl = $("#bc-slot") as HTMLElement;
  const slotTime = $("#bc-slot-time") as HTMLElement;
  const scheduleBtn = $<HTMLButtonElement>("#bc-schedule");
  const success = $("#bc-success") as HTMLElement;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "query",
      targetName: name,
    });
    if (!res?.ok) throw new Error(res?.error ?? "unknown_error");

    const { reply: replyText, facts } = res.data as {
      reply: string;
      facts: Facts | null;
    };

    root.dataset.state = "ok";
    reply.textContent = replyText;

    if (!facts) {
      root.dataset.status = "unknown";
      statusText.textContent = "não identificado";
      return;
    }

    if (facts.meeting.busy) {
      root.dataset.status = "busy";
      statusText.textContent = "em reunião";
    } else if (facts.online) {
      root.dataset.status = "available";
      statusText.textContent = "disponível agora";
    } else {
      root.dataset.status = "offline";
      statusText.textContent = "offline";
    }

    if (facts.suggestedSlot) {
      slotEl.hidden = false;
      slotTime.textContent = formatSlot(facts.suggestedSlot);
      scheduleBtn.hidden = false;
      scheduleBtn.addEventListener("click", async () => {
        scheduleBtn.disabled = true;
        scheduleBtn.textContent = "agendando…";
        try {
          const schedRes = await chrome.runtime.sendMessage({
            type: "schedule",
            targetEmail: facts.targetEmail,
            start: facts.suggestedSlot!.start,
            end: facts.suggestedSlot!.end,
            title: `Conversa rápida com ${name}`,
          });
          if (!schedRes?.ok) throw new Error(schedRes?.error ?? "unknown");
          const { htmlLink, meetLink } = schedRes.data as {
            htmlLink: string;
            meetLink: string | null;
          };
          scheduleBtn.hidden = true;
          slotEl.hidden = true;
          success.hidden = false;
          const parts: string[] = ["✅ Agendado!"];
          if (meetLink)
            parts.push(`<a href="${meetLink}" target="_blank">abrir Meet</a>`);
          if (htmlLink)
            parts.push(
              `<a href="${htmlLink}" target="_blank">ver no Calendar</a>`,
            );
          success.innerHTML = parts.join(" · ");
        } catch (err) {
          const msg = (err as Error).message;
          scheduleBtn.disabled = false;
          scheduleBtn.textContent = "📅 Tentar de novo";
          // Surface the error inline so the user doesn't need DevTools.
          success.hidden = false;
          success.style.cssText =
            "background:#fef2f2!important;color:#991b1b!important;";
          const hint = /insufficient_scope|Insufficient Permission|403/i.test(
            msg,
          )
            ? " Sair/Entrar de novo na extensão pra reautorizar o escopo de Calendar."
            : "";
          success.textContent = `❌ ${msg}.${hint}`;
          console.error("[busy-checker] schedule failed", err);
        }
      });
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Extension context invalidated")) return;
    root.dataset.state = "error";
    statusText.textContent = "erro";
    reply.textContent = msg;
  }
}

const WIDGET_HTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }

  #bc-root {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    width: 320px;
    color: #1f2328;
    background: linear-gradient(135deg, #ffffff 0%, #eef2ff 100%);
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(15, 23, 42, 0.18);
    overflow: hidden;
    animation: bc-slide-in 0.32s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-slide-in {
    from { opacity: 0; transform: translateY(16px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }

  #bc-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px;
    background: rgba(79, 70, 229, 0.06);
    border-bottom: 1px solid rgba(0,0,0,0.04);
  }
  #bc-creature {
    font-size: 32px;
    line-height: 1;
    transform-origin: 50% 70%;
    flex-shrink: 0;
  }
  #bc-root[data-state="thinking"] #bc-creature {
    animation: bc-wobble 0.8s ease-in-out infinite;
  }
  @keyframes bc-wobble {
    0%, 100% { transform: rotate(-14deg); }
    50%      { transform: rotate(14deg); }
  }
  #bc-header-text { flex: 1; min-width: 0; }
  #bc-label {
    font-size: 10px;
    color: #6366f1;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  #bc-name {
    font-size: 15px;
    font-weight: 600;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #bc-close {
    background: none;
    border: 0;
    font-size: 18px;
    color: #57606a;
    cursor: pointer;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 8px;
  }
  #bc-close:hover { background: rgba(0,0,0,0.08); }

  #bc-body { padding: 14px; }

  #bc-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  #bc-status-dot {
    width: 9px; height: 9px;
    border-radius: 50%;
    background: #9ca3af;
    box-shadow: 0 0 0 3px rgba(156, 163, 175, 0.18);
  }
  #bc-root[data-status="available"] #bc-status-dot {
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
  }
  #bc-root[data-status="busy"] #bc-status-dot {
    background: #ef4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
  }
  #bc-status-text {
    font-size: 11px;
    color: #57606a;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  #bc-reply {
    font-size: 14px;
    line-height: 1.45;
    margin: 0;
  }
  #bc-root[data-state="thinking"] #bc-reply::after {
    content: "…";
    display: inline-block;
    animation: bc-dots 1.2s steps(4, end) infinite;
    width: 1.2em;
    overflow: hidden;
    vertical-align: bottom;
  }
  @keyframes bc-dots {
    0%   { content: ""; }
    25%  { content: "."; }
    50%  { content: ".."; }
    75%  { content: "..."; }
  }

  #bc-slot {
    margin-top: 12px;
    padding: 10px 12px;
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    border-radius: 10px;
  }
  #bc-slot-label {
    font-size: 10px;
    color: #92400e;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  #bc-slot-time {
    font-size: 15px;
    font-weight: 600;
    color: #78350f;
    margin-top: 2px;
  }

  #bc-schedule {
    width: 100%;
    margin-top: 10px;
    padding: 10px 12px;
    background: #4f46e5;
    color: #fff;
    border: 0;
    border-radius: 10px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, transform 0.05s;
  }
  #bc-schedule:hover  { background: #4338ca; }
  #bc-schedule:active { transform: translateY(1px); }
  #bc-schedule:disabled {
    background: #c7d2fe;
    color: #4338ca;
    cursor: wait;
  }

  #bc-success {
    margin-top: 12px;
    padding: 10px 12px;
    background: #d1fae5;
    border-radius: 10px;
    color: #065f46;
    font-size: 13px;
    line-height: 1.5;
  }
  #bc-success a { color: #065f46; font-weight: 600; text-decoration: underline; }

  #bc-root[data-state="error"] #bc-body {
    background: #fef2f2;
  }
</style>
<div id="bc-root" data-state="thinking" data-status="unknown">
  <div id="bc-header">
    <span id="bc-creature" aria-hidden="true">🐱</span>
    <div id="bc-header-text">
      <div id="bc-label">Busy Checker</div>
      <div id="bc-name"></div>
    </div>
    <button id="bc-close" aria-label="fechar">×</button>
  </div>
  <div id="bc-body">
    <div id="bc-status-row">
      <span id="bc-status-dot"></span>
      <span id="bc-status-text">verificando</span>
    </div>
    <p id="bc-reply">consultando agenda</p>
    <div id="bc-slot" hidden>
      <div id="bc-slot-label">Próxima janela livre</div>
      <div id="bc-slot-time"></div>
    </div>
    <button id="bc-schedule" hidden type="button">📅 Agendar call (cria Meet)</button>
    <div id="bc-success" hidden></div>
  </div>
</div>
`;
