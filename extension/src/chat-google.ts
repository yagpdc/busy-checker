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

function formatCalendarParts(
  when: Date,
): { day: string; month: string; weekday: string } {
  const tz = "America/Sao_Paulo";
  return {
    day: when.toLocaleDateString("pt-BR", { timeZone: tz, day: "numeric" }),
    month: when
      .toLocaleDateString("pt-BR", { timeZone: tz, month: "short" })
      .replace(/\./g, "")
      .toUpperCase(),
    weekday: when
      .toLocaleDateString("pt-BR", { timeZone: tz, weekday: "short" })
      .replace(/\./g, ""),
  };
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
    const slotDay = $("#bc-cal-day") as HTMLElement;
    const slotMonth = $("#bc-cal-month") as HTMLElement;
    const slotWeekday = $("#bc-slot-weekday") as HTMLElement;

    // The time displayed right now (may differ from currentSlot.start while
    // animating). Used as the "from" point when chaining nav clicks mid-flight.
    let displayedTime = new Date(currentSlot.start);
    let timeAnimHandle: number | null = null;

    const writeCalendar = (when: Date) => {
      const { day, month, weekday } = formatCalendarParts(when);
      if (slotDay.textContent !== day) slotDay.textContent = day;
      if (slotMonth.textContent !== month) slotMonth.textContent = month;
      if (slotWeekday.textContent !== weekday) slotWeekday.textContent = weekday;
    };

    // Smoothly ticks the visible time + calendar from `from` to `to` with an
    // ease-in-out cubic curve. Looks like a flip-clock cycling through minutes
    // and (when it crosses midnight) flipping the day card too.
    const animateTimeTo = (from: Date, to: Date) => {
      if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
      const startMs = from.getTime();
      const endMs = to.getTime();
      const diffAbsMin = Math.abs(endMs - startMs) / 60000;
      // Slightly more deliberate pacing than before: 500ms floor, 1300ms cap.
      const duration = Math.min(
        1300,
        Math.max(500, 350 + Math.sqrt(diffAbsMin) * 35),
      );
      const startPerf = performance.now();
      const tick = (now: number) => {
        const raw = Math.min(1, (now - startPerf) / duration);
        const eased =
          raw < 0.5
            ? 4 * raw * raw * raw
            : 1 - Math.pow(-2 * raw + 2, 3) / 2;
        const currentMs = startMs + (endMs - startMs) * eased;
        const current = new Date(currentMs);
        displayedTime = current;
        slotTime.textContent = formatTime(current);
        writeCalendar(current);
        if (raw < 1) {
          timeAnimHandle = requestAnimationFrame(tick);
        } else {
          timeAnimHandle = null;
          displayedTime = to;
          slotTime.textContent = formatTime(to);
          writeCalendar(to);
        }
      };
      timeAnimHandle = requestAnimationFrame(tick);
    };

    const renderSlot = (slot: Slot, animateTime = false) => {
      const fromTime = animateTime ? displayedTime : null;
      currentSlot = slot;
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const gapMin = Math.floor((end.getTime() - start.getTime()) / 60000);

      if (fromTime) {
        animateTimeTo(fromTime, start);
      } else {
        if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
        slotTime.textContent = formatTime(start);
        writeCalendar(start);
        displayedTime = start;
      }
      const durText =
        gapMin >= 60
          ? `${Math.floor(gapMin / 60)}h${gapMin % 60 ? ` ${gapMin % 60}min` : ""}`
          : `${gapMin}min`;
      const baseHint = `Livre por ${durText} · até ${formatTime(end)}`;
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

    // Directional flash: "next" slides content up (forward in time),
    // "prev" slides content down (backward in time). Resetting the
    // attribute and forcing a reflow re-triggers the keyframe.
    const flashSlot = (direction: "next" | "prev") => {
      slotEl.removeAttribute("data-flash");
      void (slotEl as HTMLElement).offsetWidth;
      slotEl.dataset.flash = direction;
    };

    prevBtn.addEventListener("click", () => {
      if (cursor === 0) return;
      cursor--;
      flashSlot("prev");
      renderSlot(slots[cursor], true);
    });

    nextBtn.addEventListener("click", async () => {
      // Move within cached slots first.
      if (cursor < slots.length - 1) {
        cursor++;
        flashSlot("next");
        renderSlot(slots[cursor], true);
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
        flashSlot("next");
        renderSlot(slot, true); // re-enables and shows "↓" again
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
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
      "SF Pro Text", "Segoe UI Variable", "Segoe UI", Inter, system-ui,
      sans-serif;
    width: 320px;
    color: #111827;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    box-shadow:
      0 1px 2px rgba(0,0,0,0.04),
      0 12px 32px rgba(15, 23, 42, 0.10);
    overflow: hidden;
    transform-origin: bottom right;
    animation: bc-enter 0.32s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-enter {
    from { opacity: 0; transform: translateY(8px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }

  #bc-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid #f3f4f6;
  }
  #bc-header-text { flex: 1; min-width: 0; }
  #bc-label {
    font-size: 11px;
    color: #9ca3af;
    font-weight: 400;
    letter-spacing: -0.01em;
  }
  #bc-name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: #111827;
    margin-top: 2px;
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
    transition: background-color 0.25s ease;
  }
  /* Soft pulsing while the request is in flight */
  #bc-root[data-state="thinking"] #bc-status-dot {
    animation: bc-dot-pulse 1.4s ease-in-out infinite;
  }
  @keyframes bc-dot-pulse {
    0%, 100% { opacity: 0.5; transform: scale(0.85); }
    50%      { opacity: 1;   transform: scale(1.1); }
  }
  /* When we transition to a resolved state, a one-shot pop */
  #bc-root[data-state="ok"] #bc-status-dot {
    animation: bc-dot-pop 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-dot-pop {
    0%   { transform: scale(0.6); }
    55%  { transform: scale(1.4); }
    100% { transform: scale(1); }
  }
  #bc-root[data-status="available"] #bc-status-dot { background: #059669; }
  #bc-root[data-status="busy"]      #bc-status-dot { background: #dc2626; }
  #bc-root[data-status="offhours"]  #bc-status-dot { background: #d97706; }
  #bc-status-text {
    font-size: 12px;
    color: #6b7280;
    font-weight: 500;
    letter-spacing: -0.01em;
    transition: color 0.2s ease;
  }

  #bc-reply {
    font-size: 13px;
    line-height: 1.55;
    color: #374151;
    margin: 0;
    transition: opacity 0.2s ease, color 0.2s ease;
  }
  #bc-root[data-state="thinking"] #bc-reply { color: #9ca3af; }
  #bc-root[data-state="ok"] #bc-reply {
    animation: bc-reply-in 0.3s ease-out;
  }
  @keyframes bc-reply-in {
    from { opacity: 0; transform: translateY(2px); }
    to   { opacity: 1; transform: translateY(0); }
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
    margin-top: 14px;
    padding: 14px;
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  #bc-slot:hover {
    background: #f5f5f5;
    border-color: #d1d5db;
  }
  #bc-slot:not([hidden]) {
    animation: bc-section-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-section-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  /* The time + calendar tick frame-by-frame in JS (flip-clock).
     The supporting elements just slide in/out directionally. */
  #bc-slot[data-flash="next"] #bc-slot-hint,
  #bc-slot[data-flash="next"] #bc-dur-row {
    animation: bc-flash-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  #bc-slot[data-flash="prev"] #bc-slot-hint,
  #bc-slot[data-flash="prev"] #bc-dur-row {
    animation: bc-flash-down 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes bc-flash-up {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes bc-flash-down {
    from { opacity: 0; transform: translateY(-10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  /* Stagger so the supporting info comes in after the ticking starts */
  #bc-slot[data-flash] #bc-slot-hint { animation-delay: 0.18s; }
  #bc-slot[data-flash] #bc-dur-row   { animation-delay: 0.26s; }

  #bc-slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  #bc-slot-display {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  /* === Calendar tile === */
  #bc-cal {
    width: 56px;
    height: 56px;
    border-radius: 9px;
    overflow: hidden;
    border: 1px solid #d4d4d8;
    background: #ffffff;
    flex-shrink: 0;
    box-shadow:
      0 1px 2px rgba(0,0,0,0.05),
      inset 0 -1px 0 rgba(0,0,0,0.02);
    display: flex;
    flex-direction: column;
  }
  #bc-cal-month {
    background: #18181b;
    color: #fafafa;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-align: center;
    padding: 4px 0 3px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  #bc-cal-day {
    flex: 1;
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.03em;
    color: #18181b;
    text-align: center;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on, "lnum" on;
    background: linear-gradient(180deg, #ffffff 0%, #fafafa 100%);
  }

  #bc-time-block { min-width: 0; }
  #bc-slot-nav { display: flex; gap: 2px; }
  #bc-slot-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  #bc-slot-nav button {
    background: transparent;
    border: 1px solid #e5e7eb;
    color: #9ca3af;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.08s;
  }
  #bc-slot-nav button:hover:not(:disabled) {
    background: #f3f4f6;
    color: #111827;
    border-color: #d1d5db;
  }
  #bc-slot-nav button:active:not(:disabled) {
    transform: scale(0.9);
  }
  #bc-slot-nav button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  #bc-slot-time {
    font-size: 30px;
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1;
    color: #111827;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on, "lnum" on;
  }
  #bc-slot-weekday {
    font-size: 12px;
    color: #6b7280;
    margin-top: 6px;
    font-weight: 400;
    letter-spacing: -0.01em;
    text-transform: lowercase;
  }
  #bc-slot-hint {
    font-size: 11px;
    color: #9ca3af;
    margin-top: 12px;
    font-weight: 400;
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
    transition: background 0.15s, transform 0.08s, box-shadow 0.15s;
  }
  #bc-schedule:hover  {
    background: #1f2937;
    box-shadow: 0 4px 12px rgba(17, 24, 39, 0.15);
  }
  #bc-schedule:active { transform: translateY(1px); }
  #bc-schedule:not([hidden]) {
    animation: bc-section-in 0.35s 0.04s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  #bc-form {
    margin-top: 12px;
    padding: 12px;
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
  }
  #bc-form:not([hidden]) {
    animation: bc-form-expand 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    transform-origin: top center;
  }
  @keyframes bc-form-expand {
    from { opacity: 0; transform: translateY(-6px) scaleY(0.96); }
    to   { opacity: 1; transform: translateY(0)    scaleY(1); }
  }
  #bc-form label {
    display: block;
    font-size: 11px;
    color: #6b7280;
    font-weight: 500;
    letter-spacing: -0.01em;
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
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.08s;
    font-variant-numeric: tabular-nums;
  }
  .bc-dur:hover { background: #f3f4f6; }
  .bc-dur:active { transform: scale(0.95); }
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
    transition: background 0.15s, transform 0.08s;
  }
  #bc-confirm:hover { background: #1f2937; }
  #bc-confirm:active:not(:disabled) { transform: translateY(1px); }
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
    transition: background 0.15s, color 0.15s, border-color 0.15s;
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
  #bc-success:not([hidden]) {
    animation: bc-success-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-success-in {
    0%   { opacity: 0; transform: scale(0.94) translateY(-4px); }
    100% { opacity: 1; transform: scale(1)    translateY(0); }
  }
  #bc-success a { color: #166534; font-weight: 600; text-decoration: underline; }
  #bc-success a:hover { color: #14532d; }

  #bc-close { transition: background 0.15s, color 0.15s; }

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
        <div id="bc-slot-display">
          <div id="bc-cal" aria-hidden="true">
            <div id="bc-cal-month"></div>
            <div id="bc-cal-day"></div>
          </div>
          <div id="bc-time-block">
            <div id="bc-slot-time"></div>
            <div id="bc-slot-weekday"></div>
          </div>
        </div>
        <div id="bc-slot-nav">
          <button id="bc-slot-prev" type="button" title="janela anterior" disabled>↑</button>
          <button id="bc-slot-next" type="button" title="próxima janela">↓</button>
        </div>
      </div>
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
