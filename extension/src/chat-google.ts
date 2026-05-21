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
type BusyInterval = { start: string; end: string };
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
  busyAround: BusyInterval[];
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
      .toLowerCase(),
    weekday: when
      .toLocaleDateString("pt-BR", { timeZone: tz, weekday: "short" })
      .replace(/\./g, "")
      .toLowerCase(),
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
    type Entry = { slot: Slot; busy: BusyInterval[] };
    const entries: Entry[] = [
      { slot: facts.suggestedSlot, busy: facts.busyAround ?? [] },
    ];
    let cursor = 0;
    let currentSlot = entries[cursor].slot;
    let selectedDur = 30;
    let noMoreSlots = false;
    let nextFetching = false;

    const prevBtn = $<HTMLButtonElement>("#bc-day-prev");
    const nextBtn = $<HTMLButtonElement>("#bc-day-next");
    const dayCenter = $("#bc-day-center") as HTMLElement;
    const dayNum = $("#bc-day-num") as HTMLElement;
    const dayMonth = $("#bc-day-month") as HTMLElement;
    const stripEl = $("#bc-strip") as HTMLElement;
    const stripTrack = $("#bc-strip-track") as HTMLElement;

    let displayedTime = new Date(currentSlot.start);
    let timeAnimHandle: number | null = null;

    const writeDate = (when: Date) => {
      const { day, month, weekday } = formatCalendarParts(when);
      if (dayNum.textContent !== day) dayNum.textContent = day;
      if (dayMonth.textContent !== month) dayMonth.textContent = month;
      if (dayCenter.textContent !== weekday) dayCenter.textContent = weekday;
    };

    // Smoothly ticks the visible time + date from `from` to `to`.
    const animateTimeTo = (from: Date, to: Date) => {
      if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
      const startMs = from.getTime();
      const endMs = to.getTime();
      const diffAbsMin = Math.abs(endMs - startMs) / 60000;
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
        writeDate(current);
        if (raw < 1) {
          timeAnimHandle = requestAnimationFrame(tick);
        } else {
          timeAnimHandle = null;
          displayedTime = to;
          slotTime.textContent = formatTime(to);
          writeDate(to);
        }
      };
      timeAnimHandle = requestAnimationFrame(tick);
    };

    // Renders the agenda strip ±2h around the slot start.
    const STRIP_RANGE_MS = 2 * 60 * 60 * 1000;
    const renderStrip = (slot: Slot, busy: BusyInterval[]) => {
      stripTrack.innerHTML = "";
      const slotStartMs = new Date(slot.start).getTime();
      const slotEndMs = new Date(slot.end).getTime();
      const winStart = slotStartMs - STRIP_RANGE_MS;
      const winEnd = slotStartMs + STRIP_RANGE_MS;
      const totalMs = winEnd - winStart;

      // Hour tick marks
      const hourMs = 60 * 60 * 1000;
      const firstTick = Math.ceil(winStart / hourMs) * hourMs;
      for (let t = firstTick; t < winEnd; t += hourMs) {
        const pct = ((t - winStart) / totalMs) * 100;
        const tickEl = document.createElement("div");
        tickEl.className = "bc-strip-tick";
        tickEl.style.left = `${pct}%`;
        stripTrack.appendChild(tickEl);
        const label = document.createElement("div");
        label.className = "bc-strip-tick-label";
        label.style.left = `${pct}%`;
        label.textContent = formatTime(new Date(t));
        stripTrack.appendChild(label);
      }

      // Busy blocks (clipped to window)
      for (const b of busy) {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        const vs = Math.max(bs, winStart);
        const ve = Math.min(be, winEnd);
        if (ve <= vs) continue;
        const leftPct = ((vs - winStart) / totalMs) * 100;
        const widthPct = ((ve - vs) / totalMs) * 100;
        const block = document.createElement("div");
        block.className = "bc-strip-busy";
        block.style.left = `${leftPct}%`;
        block.style.width = `${widthPct}%`;
        stripTrack.appendChild(block);
      }

      // Suggested slot (dashed rectangle)
      const slotLeftPct = ((slotStartMs - winStart) / totalMs) * 100;
      const slotEndClipped = Math.min(slotEndMs, winEnd);
      const slotWidthPct = ((slotEndClipped - slotStartMs) / totalMs) * 100;
      const slotBlock = document.createElement("div");
      slotBlock.className = "bc-strip-slot";
      slotBlock.style.left = `${slotLeftPct}%`;
      slotBlock.style.width = `${slotWidthPct}%`;
      stripTrack.appendChild(slotBlock);
    };

    const fadeStripTo = (slot: Slot, busy: BusyInterval[]) => {
      stripEl.dataset.fading = "true";
      window.setTimeout(() => {
        renderStrip(slot, busy);
        stripEl.dataset.fading = "false";
      }, 180);
    };

    const updateSideLabels = () => {
      const prev = entries[cursor - 1];
      const next = entries[cursor + 1];
      if (prev) {
        prevBtn.textContent = formatCalendarParts(
          new Date(prev.slot.start),
        ).weekday;
        prevBtn.disabled = false;
      } else {
        prevBtn.textContent = "";
        prevBtn.disabled = true;
      }
      if (next) {
        nextBtn.textContent = formatCalendarParts(
          new Date(next.slot.start),
        ).weekday;
        nextBtn.disabled = false;
      } else if (noMoreSlots) {
        nextBtn.textContent = "—";
        nextBtn.disabled = true;
      } else {
        nextBtn.textContent = nextFetching ? "…" : "→";
        nextBtn.disabled = nextFetching;
      }
    };

    const prefetchNext = async () => {
      if (entries[cursor + 1] || noMoreSlots || nextFetching) return;
      nextFetching = true;
      updateSideLabels();
      try {
        const res = await chrome.runtime.sendMessage({
          type: "nextSlot",
          targetEmail: facts.targetEmail,
          after: currentSlot.end,
        });
        if (res?.ok) {
          const { slot, busyAround } = res.data as {
            slot: Slot | null;
            busyAround: BusyInterval[];
          };
          if (slot) entries.push({ slot, busy: busyAround ?? [] });
          else noMoreSlots = true;
        }
      } catch (err) {
        console.error("[busy-checker] prefetch failed", err);
      } finally {
        nextFetching = false;
        updateSideLabels();
      }
    };

    const renderSlot = (entry: Entry, animateTime = false) => {
      const fromTime = animateTime ? displayedTime : null;
      currentSlot = entry.slot;
      const start = new Date(entry.slot.start);
      const end = new Date(entry.slot.end);
      const gapMin = Math.floor((end.getTime() - start.getTime()) / 60000);

      if (fromTime) {
        animateTimeTo(fromTime, start);
        fadeStripTo(entry.slot, entry.busy);
      } else {
        if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
        slotTime.textContent = formatTime(start);
        writeDate(start);
        displayedTime = start;
        renderStrip(entry.slot, entry.busy);
      }

      // Duration chips for the schedule form (capped to gap size)
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

      updateSideLabels();
      // Pre-fetch the next slot in the background so the side label shows
      // its weekday before the user clicks.
      void prefetchNext();
    };

    const flashSlot = (direction: "next" | "prev") => {
      slotEl.removeAttribute("data-flash");
      void (slotEl as HTMLElement).offsetWidth;
      slotEl.dataset.flash = direction;
    };

    prevBtn.addEventListener("click", () => {
      if (cursor === 0 || prevBtn.disabled) return;
      cursor--;
      flashSlot("prev");
      renderSlot(entries[cursor], true);
    });

    nextBtn.addEventListener("click", async () => {
      if (nextBtn.disabled) return;
      if (cursor < entries.length - 1) {
        cursor++;
        flashSlot("next");
        renderSlot(entries[cursor], true);
        return;
      }
      if (noMoreSlots) return;
      await prefetchNext();
      if (entries[cursor + 1]) {
        cursor++;
        flashSlot("next");
        renderSlot(entries[cursor], true);
      }
    });

    slotEl.hidden = false;
    scheduleBtn.hidden = false;
    titleInput.value = `Conversa com ${name}`;
    renderSlot(entries[0]);

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
  }
  #bc-slot:not([hidden]) {
    animation: bc-section-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes bc-section-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* === Day carousel === */
  #bc-days {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .bc-day-side {
    font: inherit;
    font-size: 11px;
    font-weight: 400;
    color: #d4d4d8;
    background: none;
    border: 0;
    padding: 4px 6px;
    cursor: pointer;
    letter-spacing: -0.01em;
    text-transform: lowercase;
    transition: color 0.15s ease, opacity 0.2s ease;
    font-variant-numeric: tabular-nums;
    min-width: 44px;
    text-align: center;
  }
  .bc-day-side:hover:not(:disabled) { color: #6b7280; }
  .bc-day-side:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }
  #bc-day-prev { text-align: left; }
  #bc-day-next { text-align: right; }
  .bc-day-c {
    font-size: 13px;
    font-weight: 600;
    color: #111827;
    letter-spacing: -0.01em;
    text-transform: lowercase;
    transition: opacity 0.2s ease;
  }
  /* When animating between slots, slightly mute the center so the
     transition feels softer */
  #bc-slot[data-flash] .bc-day-c {
    animation: bc-pulse 0.4s ease-out;
  }
  @keyframes bc-pulse {
    0%   { opacity: 0.5; }
    100% { opacity: 1; }
  }
  #bc-slot[data-flash="next"] #bc-day-prev,
  #bc-slot[data-flash="prev"] #bc-day-next {
    animation: bc-side-fade-in 0.35s ease-out both;
  }
  @keyframes bc-side-fade-in {
    from { opacity: 0; transform: translateX(4px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  /* === Hero: big day number + big time === */
  #bc-hero {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin: 4px 0 2px;
  }
  #bc-day-num {
    font-size: 44px;
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 1;
    color: #111827;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on, "lnum" on;
  }
  #bc-slot-time {
    font-size: 44px;
    font-weight: 300;
    letter-spacing: -0.03em;
    line-height: 1;
    color: #111827;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on, "lnum" on;
  }
  #bc-day-month {
    font-size: 11px;
    color: #9ca3af;
    letter-spacing: -0.01em;
    text-transform: lowercase;
    margin-bottom: 12px;
  }

  /* === Agenda strip === */
  #bc-strip {
    position: relative;
    height: 52px;
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
  }
  #bc-strip-track {
    position: absolute;
    inset: 0;
    transition: opacity 0.18s ease;
  }
  #bc-strip[data-fading="true"] #bc-strip-track { opacity: 0; }

  .bc-strip-tick {
    position: absolute;
    top: 4px;
    bottom: 14px;
    width: 1px;
    background: rgba(0,0,0,0.05);
  }
  .bc-strip-tick-label {
    position: absolute;
    bottom: 2px;
    font-size: 9px;
    color: #a1a1aa;
    transform: translateX(-50%);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .bc-strip-busy {
    position: absolute;
    top: 10px;
    bottom: 16px;
    background: #d4d4d8;
    border-radius: 3px;
  }
  .bc-strip-slot {
    position: absolute;
    top: 6px;
    bottom: 12px;
    border: 1.5px dashed #111827;
    border-radius: 5px;
    background: rgba(17, 24, 39, 0.04);
    box-sizing: border-box;
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
      <div id="bc-days">
        <button id="bc-day-prev" class="bc-day-side" type="button" disabled></button>
        <span id="bc-day-center" class="bc-day-c"></span>
        <button id="bc-day-next" class="bc-day-side" type="button"></button>
      </div>
      <div id="bc-hero">
        <span id="bc-day-num"></span>
        <span id="bc-slot-time"></span>
      </div>
      <div id="bc-day-month"></div>
      <div id="bc-strip" aria-hidden="true"><div id="bc-strip-track"></div></div>
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
