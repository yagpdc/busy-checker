/// <reference types="chrome" />
// Runs only on chat.google.com. Detects open DMs, extracts the participant
// name from <title>, injects a floating widget that asks the backend
// whether the person is available + offers to schedule the next free slot.

const WIDGET_ID = "busy-checker-widget";

// === URL / title watcher ===
let lastKey: string | null = null;

function currentConversationName(): string | null {
  // Observed title formats:
  //   "<Name> - Google Chat" | "<Name> - Chat" | "(3) <Name> - Chat"
  //   "Google Chat" | "Chat" (nothing open)
  // \p{Pd} matches any Unicode dash.
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
  host.style.cssText =
    "all:initial;position:fixed!important;bottom:24px!important;right:24px!important;z-index:2147483647!important;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = WIDGET_HTML;
  (document.documentElement || document.body).appendChild(host);

  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  ($("#bc-name") as HTMLElement).textContent = name;
  $<HTMLButtonElement>("#bc-close").addEventListener("click", removeWidget);
  // Suppress event propagation so clicks inside the widget never trigger
  // Chat's own handlers.
  shadow
    .querySelector("#bc-root")
    ?.addEventListener("click", (e) => e.stopPropagation());

  void askBackend(name, shadow);
}

type Slot = { start: string; end: string };
type Facts = {
  targetEmail: string;
  online: boolean;
  lastActivityAt: string | null;
  meeting:
    | { busy: false }
    | {
        busy: true;
        kind: "meeting" | "outOfOffice" | "focusTime";
        title: string | null;
        endsAt: string;
      };
  suggestedSlot: Slot | null;
  outsideWorkingHours: boolean;
  workingHours: { start: number; end: number };
};

function formatTime(d: Date): string {
  return d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSlot(slot: Slot): string {
  const start = new Date(slot.start);
  const now = new Date();
  const tz = "America/Sao_Paulo";
  const sameDay =
    start.toLocaleDateString("pt-BR", { timeZone: tz }) ===
    now.toLocaleDateString("pt-BR", { timeZone: tz });
  if (sameDay) return `hoje às ${formatTime(start)}`;
  return (
    start.toLocaleDateString("pt-BR", {
      timeZone: tz,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    }) + ` às ${formatTime(start)}`
  );
}

const DURATION_OPTIONS_MIN = [15, 30, 45, 60, 90, 120];

async function askBackend(name: string, shadow: ShadowRoot): Promise<void> {
  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  const root = $("#bc-root") as HTMLElement;
  const reply = $("#bc-reply") as HTMLElement;
  const statusText = $("#bc-status-text") as HTMLElement;
  const slotEl = $("#bc-slot") as HTMLElement;
  const slotTime = $("#bc-slot-time") as HTMLElement;
  const slotHint = $("#bc-slot-hint") as HTMLElement;
  const scheduleBtn = $<HTMLButtonElement>("#bc-schedule");
  const form = $("#bc-form") as HTMLElement;
  const titleInput = $<HTMLInputElement>("#bc-title");
  const durRow = $("#bc-dur-row") as HTMLElement;
  const confirmBtn = $<HTMLButtonElement>("#bc-confirm");
  const cancelBtn = $<HTMLButtonElement>("#bc-cancel");
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
      if (facts.meeting.kind === "outOfOffice") {
        statusText.textContent = "ausente";
      } else if (facts.meeting.kind === "focusTime") {
        statusText.textContent = "em foco";
      } else {
        statusText.textContent = "em reunião";
      }
    } else if (facts.outsideWorkingHours) {
      root.dataset.status = "offhours";
      statusText.textContent = "fora do horário";
    } else {
      root.dataset.status = "available";
      statusText.textContent = "disponível agora";
    }

    if (!facts.suggestedSlot) return;

    // === Slot navigation state ===
    // We start with the first slot from /query; arrows walk a locally-cached
    // list, fetching forward from /slots/next on demand.
    const slots: Slot[] = [facts.suggestedSlot];
    let cursor = 0;
    let currentSlot = slots[cursor];
    let selectedDur = 30;
    let noMoreSlots = false;
    const prevBtn = $<HTMLButtonElement>("#bc-slot-prev");
    const nextBtn = $<HTMLButtonElement>("#bc-slot-next");

    const renderSlot = (slot: Slot) => {
      currentSlot = slot;
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const gapMin = Math.floor((end.getTime() - start.getTime()) / 60000);

      slotTime.textContent = formatSlot(slot);
      const durText =
        gapMin >= 60
          ? `${Math.floor(gapMin / 60)}h${gapMin % 60 ? ` ${gapMin % 60}min` : ""}`
          : `${gapMin}min`;
      const baseHint = `livre por ${durText} (até ${formatTime(end)})`;
      const atEnd = cursor === slots.length - 1;
      slotHint.textContent =
        atEnd && noMoreSlots ? `${baseHint} · sem mais janelas` : baseHint;

      // Rebuild duration chips for the new gap. Keep the previous selection
      // if it still fits, else fall back to 30 or the first option.
      const validDurations = DURATION_OPTIONS_MIN.filter((m) => m <= gapMin);
      if (validDurations.length === 0) validDurations.push(gapMin);
      if (!validDurations.includes(selectedDur)) {
        selectedDur = validDurations.includes(30) ? 30 : validDurations[0];
      }
      durRow.innerHTML = "";
      validDurations.forEach((m) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bc-dur";
        btn.textContent = m >= 60 ? `${m / 60}h` : `${m}m`;
        if (m === selectedDur) btn.dataset.selected = "true";
        btn.addEventListener("click", () => {
          durRow
            .querySelectorAll(".bc-dur")
            .forEach((b) => delete (b as HTMLElement).dataset.selected);
          btn.dataset.selected = "true";
          selectedDur = m;
        });
        durRow.appendChild(btn);
      });

      prevBtn.disabled = cursor === 0;
      if (atEnd && noMoreSlots) {
        nextBtn.disabled = true;
        nextBtn.textContent = "—";
      } else {
        nextBtn.disabled = false;
        nextBtn.textContent = "↓";
      }
    };

    prevBtn.addEventListener("click", () => {
      if (cursor === 0) return;
      cursor--;
      renderSlot(slots[cursor]);
    });

    nextBtn.addEventListener("click", async () => {
      // Move within cached slots first.
      if (cursor < slots.length - 1) {
        cursor++;
        renderSlot(slots[cursor]);
        return;
      }
      if (noMoreSlots) return;

      // Need to fetch.
      nextBtn.disabled = true;
      nextBtn.textContent = "…";
      try {
        const res = await chrome.runtime.sendMessage({
          type: "nextSlot",
          targetEmail: facts.targetEmail,
          after: currentSlot.end,
        });
        if (!res?.ok) throw new Error(res?.error ?? "unknown");
        const slot = (res.data as { slot: Slot | null }).slot;
        if (!slot) {
          noMoreSlots = true;
          renderSlot(currentSlot); // updates button to "—" and hint
          return;
        }
        slots.push(slot);
        cursor++;
        renderSlot(slot); // re-enables and shows "▼" again
      } catch (err) {
        console.error("[busy-checker] nextSlot failed", err);
        nextBtn.disabled = false;
        nextBtn.textContent = "↓";
      }
    });

    slotEl.hidden = false;
    scheduleBtn.hidden = false;
    titleInput.value = `Conversa com ${name}`;
    renderSlot(facts.suggestedSlot);

    scheduleBtn.addEventListener("click", () => {
      scheduleBtn.hidden = true;
      form.hidden = false;
      titleInput.focus();
      titleInput.select();
    });

    cancelBtn.addEventListener("click", () => {
      form.hidden = true;
      scheduleBtn.hidden = false;
      success.hidden = true;
      success.removeAttribute("style");
    });

    confirmBtn.addEventListener("click", async () => {
      const title = titleInput.value.trim() || `Conversa com ${name}`;
      const start = currentSlot.start;
      const end = new Date(
        new Date(currentSlot.start).getTime() + selectedDur * 60000,
      ).toISOString();

      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = "agendando…";
      success.hidden = true;
      success.removeAttribute("style");

      try {
        const schedRes = await chrome.runtime.sendMessage({
          type: "schedule",
          targetEmail: facts.targetEmail,
          start,
          end,
          title,
        });
        if (!schedRes?.ok) throw new Error(schedRes?.error ?? "unknown");
        const { htmlLink, meetLink } = schedRes.data as {
          htmlLink: string;
          meetLink: string | null;
        };
        form.hidden = true;
        slotEl.hidden = true;
        success.hidden = false;
        const parts: string[] = [
          `<strong>"${title}"</strong> agendada.`,
        ];
        if (meetLink)
          parts.push(`<a href="${meetLink}" target="_blank">Abrir Meet</a>`);
        if (htmlLink)
          parts.push(`<a href="${htmlLink}" target="_blank">Ver evento</a>`);
        success.innerHTML = parts.join(" · ");
      } catch (err) {
        const msg = (err as Error).message;
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        confirmBtn.textContent = "Confirmar";
        success.hidden = false;
        success.style.cssText =
          "background:#fef2f2!important;color:#991b1b!important;";
        const hint = /insufficient_scope|Insufficient Permission|403/i.test(msg)
          ? " Saia e entre de novo na extensão pra reautorizar."
          : "";
        success.textContent = `${msg}.${hint}`;
        console.error("[busy-checker] schedule failed", err);
      }
    });
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
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    width: 320px;
    color: #111827;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    box-shadow:
      0 1px 2px rgba(0,0,0,0.04),
      0 12px 32px rgba(15, 23, 42, 0.10);
    overflow: hidden;
    animation: bc-fade-up 0.18s ease-out;
  }
  @keyframes bc-fade-up {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  #bc-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid #f3f4f6;
  }
  #bc-header-text { flex: 1; min-width: 0; }
  #bc-label {
    font-size: 10px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-weight: 600;
  }
  #bc-name {
    font-size: 14px;
    font-weight: 600;
    color: #111827;
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #bc-close {
    background: none;
    border: 0;
    color: #9ca3af;
    cursor: pointer;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 18px;
  }
  #bc-close:hover { background: #f3f4f6; color: #374151; }

  #bc-body { padding: 14px; }

  #bc-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  #bc-status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #9ca3af;
  }
  #bc-root[data-status="available"] #bc-status-dot { background: #059669; }
  #bc-root[data-status="busy"]      #bc-status-dot { background: #dc2626; }
  #bc-root[data-status="offhours"]  #bc-status-dot { background: #d97706; }
  #bc-status-text {
    font-size: 10px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  #bc-reply {
    font-size: 13px;
    line-height: 1.55;
    color: #374151;
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
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
  }
  #bc-slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  #bc-slot-label {
    font-size: 10px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-weight: 600;
  }
  #bc-slot-nav { display: flex; gap: 2px; }
  #bc-slot-nav button {
    background: transparent;
    border: 1px solid #e5e7eb;
    color: #6b7280;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition: all 0.12s;
  }
  #bc-slot-nav button:hover:not(:disabled) {
    background: #f3f4f6;
    color: #111827;
    border-color: #d1d5db;
  }
  #bc-slot-nav button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  #bc-slot-time {
    font-size: 14px;
    font-weight: 600;
    color: #111827;
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  #bc-slot-hint {
    font-size: 11px;
    color: #6b7280;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  #bc-schedule {
    width: 100%;
    margin-top: 10px;
    padding: 9px 12px;
    background: #111827;
    color: #ffffff;
    border: 0;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s;
  }
  #bc-schedule:hover  { background: #1f2937; }

  #bc-form {
    margin-top: 12px;
    padding: 12px;
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
  }
  #bc-form label {
    display: block;
    font-size: 10px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-weight: 600;
    margin-bottom: 6px;
  }
  #bc-title {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    background: #ffffff;
    color: #111827;
  }
  #bc-title:focus {
    outline: 0;
    border-color: #111827;
    box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
  }
  #bc-dur-label { margin-top: 10px; }
  #bc-dur-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .bc-dur {
    padding: 5px 10px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #ffffff;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: #374151;
    cursor: pointer;
    transition: all 0.12s;
    font-variant-numeric: tabular-nums;
  }
  .bc-dur:hover { background: #f3f4f6; }
  .bc-dur[data-selected="true"] {
    background: #111827;
    color: #ffffff;
    border-color: #111827;
  }

  #bc-actions {
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  #bc-confirm {
    flex: 1;
    padding: 8px 12px;
    background: #111827;
    color: #ffffff;
    border: 0;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  #bc-confirm:hover { background: #1f2937; }
  #bc-confirm:disabled {
    background: #9ca3af;
    cursor: wait;
  }
  #bc-cancel {
    padding: 8px 12px;
    background: #ffffff;
    color: #6b7280;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  #bc-cancel:hover { background: #f9fafb; color: #374151; }
  #bc-cancel:disabled { cursor: wait; opacity: 0.6; }

  #bc-success {
    margin-top: 12px;
    padding: 10px 12px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
    color: #166534;
    font-size: 12px;
    line-height: 1.55;
  }
  #bc-success a { color: #166534; font-weight: 600; text-decoration: underline; }

  #bc-root[data-state="error"] #bc-body { background: #fef2f2; }
</style>
<div id="bc-root" data-state="thinking" data-status="unknown">
  <div id="bc-header">
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
      <div id="bc-slot-head">
        <div id="bc-slot-label">Próxima janela</div>
        <div id="bc-slot-nav">
          <button id="bc-slot-prev" type="button" title="janela anterior" disabled>↑</button>
          <button id="bc-slot-next" type="button" title="próxima janela">↓</button>
        </div>
      </div>
      <div id="bc-slot-time"></div>
      <div id="bc-slot-hint"></div>
    </div>
    <button id="bc-schedule" hidden type="button">Agendar nesta janela</button>
    <div id="bc-form" hidden>
      <label for="bc-title">Nome da reunião</label>
      <input id="bc-title" type="text" maxlength="120" />
      <label id="bc-dur-label" for="bc-dur-row">Duração</label>
      <div id="bc-dur-row"></div>
      <div id="bc-actions">
        <button id="bc-confirm" type="button">Confirmar</button>
        <button id="bc-cancel" type="button">Cancelar</button>
      </div>
    </div>
    <div id="bc-success" hidden></div>
  </div>
</div>
`;
