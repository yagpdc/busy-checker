/// <reference types="chrome" />
// Runs only on chat.google.com. Detects open DMs, extracts the participant
// name from <title>, injects a floating widget that asks the backend
// whether the person is available + offers to schedule the next free slot.
//
// NOTE: MV3 content scripts run as classic scripts (no ES module imports).
// All helpers must be inlined here. The duplicated Settings shape mirrors
// extension/src/settings.ts (which is used by the popup).

const WIDGET_ID = "busy-checker-widget";

type Settings = {
  workStartHour: number;
  workEndHour: number;
  eventColor: string;
};
const DEFAULT_SETTINGS: Settings = {
  workStartHour: 9,
  workEndHour: 18,
  eventColor: "#3b82f6",
};
async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const s = (settings ?? {}) as Partial<Settings>;
  const hex =
    typeof s.eventColor === "string" && /^#[0-9a-f]{6}$/i.test(s.eventColor)
      ? s.eventColor
      : DEFAULT_SETTINGS.eventColor;
  return {
    workStartHour:
      typeof s.workStartHour === "number"
        ? s.workStartHour
        : DEFAULT_SETTINGS.workStartHour,
    workEndHour:
      typeof s.workEndHour === "number"
        ? s.workEndHour
        : DEFAULT_SETTINGS.workEndHour,
    eventColor: hex,
  };
}

function textColorFor(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#111827" : "#ffffff";
}

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
type CalendarEvent = { start: string; end: string; title: string | null };
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
  eventsAround: CalendarEvent[];
  meetingsToday: number | null;
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
      .toLocaleDateString("pt-BR", { timeZone: tz, weekday: "long" })
      .replace(/-feira/g, "")
      .toLowerCase(),
  };
}

function formatTimeParts(d: Date): { hour: string; minute: string } {
  const formatted = d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  const [hour, minute] = formatted.split(":");
  return { hour, minute };
}

// Returns midnight (00:00) of the SP-local day AFTER `after`. Used as the
// `after` cursor when navigating to the next day's first free slot.
function nextSpDayMidnight(after: Date): Date {
  const TZ_OFFSET_MS = -3 * 60 * 60 * 1000;
  const local = new Date(after.getTime() + TZ_OFFSET_MS);
  local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - TZ_OFFSET_MS);
}

const DURATION_OPTIONS_MIN = [15, 30, 45, 60, 90, 120];

async function askBackend(name: string, shadow: ShadowRoot): Promise<void> {
  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  const root = $("#bc-root") as HTMLElement;
  const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  const eventColor = settings.eventColor;
  const eventTextColor = textColorFor(eventColor);
  const emailEl = $("#bc-email") as HTMLElement;
  const meetingsBadge = $("#bc-meetings-badge") as HTMLElement;
  const meetingsCount = $("#bc-meetings-count") as HTMLElement;
  const slotEl = $("#bc-slot") as HTMLElement;
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

    const { facts } = res.data as {
      reply: string;
      facts: Facts | null;
    };

    root.dataset.state = "ok";

    if (!facts) return;

    emailEl.textContent = facts.targetEmail;
    const n = facts.meetingsToday;
    if (n === null) {
      meetingsBadge.hidden = true;
    } else {
      meetingsBadge.hidden = false;
      meetingsCount.textContent = String(n);
    }

    if (!facts.suggestedSlot) return;

    // === Slot navigation state ===
    type Entry = { slot: Slot; events: CalendarEvent[] };
    const entries: Entry[] = [
      { slot: facts.suggestedSlot, events: facts.eventsAround ?? [] },
    ];
    let cursor = 0;
    let currentSlot = entries[cursor].slot;
    let selectedDur = 30;
    let noMoreSlots = false;
    let nextFetching = false;

    const prevBtn = $<HTMLButtonElement>("#bc-day-prev");
    const nextBtn = $<HTMLButtonElement>("#bc-day-next");
    const dayCenter = $("#bc-day-center") as HTMLElement;
    const calMonth = $("#bc-cal-month") as HTMLElement;
    const calDay = $("#bc-cal-day") as HTMLElement;
    const hourEl = $("#bc-time-hour") as HTMLElement;
    const minEl = $("#bc-time-minute") as HTMLElement;
    const agendaEl = $("#bc-agenda") as HTMLElement;

    let displayedTime = new Date(currentSlot.start);
    let timeAnimHandle: number | null = null;

    const writeDate = (when: Date) => {
      const { day, month, weekday } = formatCalendarParts(when);
      if (calDay.textContent !== day) calDay.textContent = day;
      if (calMonth.textContent !== month) calMonth.textContent = month;
      if (dayCenter.textContent !== weekday) dayCenter.textContent = weekday;
    };

    const writeClock = (when: Date) => {
      const { hour, minute } = formatTimeParts(when);
      if (hourEl.textContent !== hour) hourEl.textContent = hour;
      if (minEl.textContent !== minute) minEl.textContent = minute;
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
        writeClock(current);
        writeDate(current);
        if (raw < 1) {
          timeAnimHandle = requestAnimationFrame(tick);
        } else {
          timeAnimHandle = null;
          displayedTime = to;
          writeClock(to);
          writeDate(to);
        }
      };
      timeAnimHandle = requestAnimationFrame(tick);
    };

    // Renders the agenda as a vertical timeline (Google-Calendar-style):
    // events are absolutely positioned by their start time, height is
    // proportional to duration, and the suggested slot is drawn as a
    // dashed empty block in chronological position.
    const PX_PER_MIN = 0.95; // ~57 px per hour
    const WINDOW_RANGE_MS = 2.5 * 60 * 60 * 1000; // ±2.5h around slot
    const MIN_EVENT_HEIGHT = 28; // keep text readable on short events

    const renderAgenda = (slot: Slot, events: CalendarEvent[]) => {
      agendaEl.innerHTML = "";
      const slotStartMs = new Date(slot.start).getTime();
      const slotEndMs = new Date(slot.end).getTime();
      const winStart = slotStartMs - WINDOW_RANGE_MS;
      const winEnd = slotStartMs + WINDOW_RANGE_MS;
      const totalMin = (winEnd - winStart) / 60000;
      agendaEl.style.height = `${totalMin * PX_PER_MIN}px`;

      // Hour gridlines + side labels
      const hourMs = 60 * 60 * 1000;
      const firstHour = Math.ceil(winStart / hourMs) * hourMs;
      for (let t = firstHour; t < winEnd; t += hourMs) {
        const topPx = ((t - winStart) / 60000) * PX_PER_MIN;
        const line = document.createElement("div");
        line.className = "bc-tl-line";
        line.style.top = `${topPx}px`;
        agendaEl.appendChild(line);
        const lbl = document.createElement("div");
        lbl.className = "bc-tl-hour";
        lbl.style.top = `${topPx}px`;
        lbl.textContent = formatTime(new Date(t));
        agendaEl.appendChild(lbl);
      }

      const sortedEvents = [...events].sort(
        (a, b) =>
          new Date(a.start).getTime() - new Date(b.start).getTime(),
      );

      for (const ev of sortedEvents) {
        const eStart = new Date(ev.start).getTime();
        const eEnd = new Date(ev.end).getTime();
        const visStart = Math.max(eStart, winStart);
        const visEnd = Math.min(eEnd, winEnd);
        if (visEnd <= visStart) continue;
        const topPx = ((visStart - winStart) / 60000) * PX_PER_MIN;
        const heightPx = Math.max(
          MIN_EVENT_HEIGHT,
          ((visEnd - visStart) / 60000) * PX_PER_MIN,
        );
        const block = document.createElement("div");
        block.className = "bc-ev";
        block.style.top = `${topPx}px`;
        block.style.height = `${heightPx}px`;
        block.style.background = eventColor;
        block.style.color = eventTextColor;
        const titleText = (ev.title ?? "").trim() || "(sem título)";
        block.innerHTML = `
          <div class="bc-ev-time"></div>
          <div class="bc-ev-title"></div>
        `;
        (block.querySelector(".bc-ev-time") as HTMLElement).textContent =
          formatTime(new Date(eStart));
        (block.querySelector(".bc-ev-title") as HTMLElement).textContent =
          titleText;
        agendaEl.appendChild(block);
      }

      // Suggested slot — dashed transparent block
      const slotTopPx = ((slotStartMs - winStart) / 60000) * PX_PER_MIN;
      const slotEndClipped = Math.min(slotEndMs, winEnd);
      const slotHeightPx = Math.max(
        MIN_EVENT_HEIGHT,
        ((slotEndClipped - slotStartMs) / 60000) * PX_PER_MIN,
      );
      const slotMin = Math.floor((slotEndMs - slotStartMs) / 60000);
      const slotTitle =
        slotMin >= 60
          ? `slot livre · ${Math.floor(slotMin / 60)}h${slotMin % 60 ? ` ${slotMin % 60}min` : ""}`
          : `slot livre · ${slotMin}min`;
      const slotBlock = document.createElement("div");
      slotBlock.className = "bc-ev bc-ev-slot";
      slotBlock.style.top = `${slotTopPx}px`;
      slotBlock.style.height = `${slotHeightPx}px`;
      slotBlock.innerHTML = `
        <div class="bc-ev-time"></div>
        <div class="bc-ev-title"></div>
      `;
      (slotBlock.querySelector(".bc-ev-time") as HTMLElement).textContent =
        formatTime(new Date(slotStartMs));
      (slotBlock.querySelector(".bc-ev-title") as HTMLElement).textContent =
        slotTitle;
      agendaEl.appendChild(slotBlock);
    };

    const fadeAgendaTo = (slot: Slot, events: CalendarEvent[]) => {
      slotEl.dataset.fading = "true";
      window.setTimeout(() => {
        renderAgenda(slot, events);
        slotEl.dataset.fading = "false";
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
        // Day-based navigation: jump to midnight of the next SP day so the
        // returned slot is the FIRST free window on a DIFFERENT day (skips
        // any remaining slots on the current day).
        const after = nextSpDayMidnight(
          new Date(currentSlot.start),
        ).toISOString();
        const res = await chrome.runtime.sendMessage({
          type: "nextSlot",
          targetEmail: facts.targetEmail,
          after,
        });
        if (res?.ok) {
          const { slot, eventsAround: nextEvents } = res.data as {
            slot: Slot | null;
            eventsAround: CalendarEvent[];
          };
          if (slot) entries.push({ slot, events: nextEvents ?? [] });
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
        fadeAgendaTo(entry.slot, entry.events);
      } else {
        if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
        writeClock(start);
        writeDate(start);
        displayedTime = start;
        renderAgenda(entry.slot, entry.events);
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
    emailEl.textContent = msg;
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
    align-items: center;
    gap: 10px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid #f3f4f6;
  }
  #bc-header-text { flex: 1; min-width: 0; }
  #bc-name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #bc-meetings-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: #f3f4f6;
    border-radius: 999px;
    color: #6b7280;
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .bc-cal-icon {
    width: 13px;
    height: 13px;
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

  /* status row removed — status is implicit in the timeline below */

  #bc-email {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    font-size: 12px;
    font-weight: 500;
    color: #d4d4d8;
    background: none;
    border: 0;
    padding: 4px 6px;
    cursor: pointer;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    transition: color 0.15s ease, opacity 0.2s ease;
    font-variant-numeric: tabular-nums;
    min-width: 56px;
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
    font-size: 15px;
    font-weight: 600;
    color: #111827;
    letter-spacing: 0.04em;
    text-transform: uppercase;
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

  /* === Clock row: calendar tile + flip-clock cards, justify-between === */
  #bc-clock-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 4px 0 14px;
  }

  /* Calendar tile (date) */
  #bc-cal-tile {
    width: 56px;
    height: 60px;
    border-radius: 9px;
    overflow: hidden;
    border: 1px solid #d4d4d8;
    background: #ffffff;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
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
    text-transform: uppercase;
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

  /* Flip-clock cards (HH MM) */
  #bc-flip-clock {
    display: flex;
    gap: 5px;
    flex-shrink: 0;
  }
  .bc-flip-card {
    background: #ffffff;
    border: 1px solid #d4d4d8;
    border-radius: 7px;
    width: 52px;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on, "lnum" on;
    line-height: 1;
    position: relative;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    overflow: hidden;
  }
  /* Hairline horizontal split — mimics the seam between top/bottom flap */
  .bc-flip-card::after {
    content: "";
    position: absolute;
    left: 0; right: 0;
    top: 50%;
    height: 1px;
    background: rgba(0,0,0,0.08);
    pointer-events: none;
  }

  /* === Agenda (Google Calendar timeline) ===
     Vertical timeline; events absolutely positioned by start time, height
     proportional to duration. */
  #bc-agenda {
    position: relative;
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    transition: opacity 0.18s ease;
    padding-left: 36px; /* leaves space for hour labels */
  }
  #bc-slot[data-fading="true"] #bc-agenda { opacity: 0; }

  .bc-tl-line {
    position: absolute;
    left: 36px;
    right: 6px;
    height: 1px;
    background: rgba(0,0,0,0.05);
  }
  .bc-tl-hour {
    position: absolute;
    left: 6px;
    width: 30px;
    font-size: 9px;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
    transform: translateY(-50%);
    letter-spacing: -0.02em;
  }

  .bc-ev {
    position: absolute;
    left: 38px;
    right: 6px;
    padding: 3px 8px;
    border-radius: 5px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 1px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  .bc-ev-time {
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on;
    letter-spacing: -0.02em;
    opacity: 0.85;
    line-height: 1.15;
  }
  .bc-ev-title {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: normal;
  }
  /* Slot: transparent + dashed border, dark text */
  .bc-ev.bc-ev-slot {
    background: transparent !important;
    color: #111827 !important;
    border: 1.5px dashed #111827;
    box-shadow: none;
    z-index: 2;
  }
  .bc-ev.bc-ev-slot .bc-ev-time { opacity: 1; font-weight: 600; }

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
      <div id="bc-name"></div>
      <div id="bc-email"></div>
    </div>
    <div id="bc-meetings-badge" hidden>
      <svg class="bc-cal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="16" y1="2" x2="16" y2="6"></line>
        <line x1="8" y1="2" x2="8" y2="6"></line>
        <line x1="3" y1="10" x2="21" y2="10"></line>
      </svg>
      <span id="bc-meetings-count"></span>
    </div>
    <button id="bc-close" aria-label="fechar">×</button>
  </div>
  <div id="bc-body">
    <div id="bc-slot" hidden>
      <div id="bc-days">
        <button id="bc-day-prev" class="bc-day-side" type="button" disabled></button>
        <span id="bc-day-center" class="bc-day-c"></span>
        <button id="bc-day-next" class="bc-day-side" type="button"></button>
      </div>
      <div id="bc-clock-row">
        <div id="bc-cal-tile" aria-hidden="true">
          <div id="bc-cal-month"></div>
          <div id="bc-cal-day"></div>
        </div>
        <div id="bc-flip-clock" aria-hidden="true">
          <div class="bc-flip-card" id="bc-time-hour"></div>
          <div class="bc-flip-card" id="bc-time-minute"></div>
        </div>
      </div>
      <div id="bc-agenda"></div>
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
