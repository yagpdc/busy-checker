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
  widgetEnabled: boolean;
};
const DEFAULT_SETTINGS: Settings = {
  workStartHour: 9,
  workEndHour: 18,
  eventColor: "#3b82f6",
  widgetEnabled: true,
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
    widgetEnabled:
      typeof s.widgetEnabled === "boolean"
        ? s.widgetEnabled
        : DEFAULT_SETTINGS.widgetEnabled,
  };
}

// Cached at module scope so the tight reactToState loop doesn't have to
// await chrome.storage on every tick. Initialized in bootstrap below;
// kept in sync via chrome.storage.onChanged.
//
// widgetEnabled (persistent, local) — the "never show this" master switch
//   from the popup settings page.
// widgetOpen (session-scoped) — the "closed for now" flag toggled by the X
//   button on the widget OR the switch on the popup home view. Defaults to
//   true on a fresh browser session.
let widgetEnabled = DEFAULT_SETTINGS.widgetEnabled;
let widgetOpen = true;

// Google Chat enforces Trusted Types: setting .innerHTML with a raw string
// throws. Register an extension policy that returns the string verbatim, or
// fall back to DOMParser if creation is blocked. Either path bypasses the
// "Uncaught" error and inserts the HTML correctly.
type TTPolicyShape = { createHTML: (s: string) => string };
const ttPolicy: TTPolicyShape | null = (() => {
  const w = window as unknown as {
    trustedTypes?: {
      createPolicy?: (
        name: string,
        rules: { createHTML: (s: string) => string },
      ) => TTPolicyShape;
    };
  };
  if (!w.trustedTypes?.createPolicy) return null;
  try {
    return w.trustedTypes.createPolicy("busy-checker", {
      createHTML: (s: string) => s,
    });
  } catch (err) {
    console.warn("[busy-checker] TT policy creation failed", err);
    return null;
  }
})();

function clearChildren(el: Element | ShadowRoot): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function setInnerHTML(el: Element | ShadowRoot, html: string): void {
  clearChildren(el);
  if (ttPolicy) {
    (el as { innerHTML: string }).innerHTML = ttPolicy.createHTML(
      html,
    ) as unknown as string;
    return;
  }
  // Fallback: parse via DOMParser then append. DOMParser doesn't trigger
  // TT enforcement because the parsed nodes aren't yet attached to the
  // live document.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const frag = document.createDocumentFragment();
  parsed.head.childNodes.forEach((n) => frag.appendChild(n.cloneNode(true)));
  parsed.body.childNodes.forEach((n) => frag.appendChild(n.cloneNode(true)));
  el.appendChild(frag);
}

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
//
// State is keyed by URL pathname, not by title. Google Chat mutates
// document.title a lot — unread counts, typing indicators, notifications
// from other conversations all rewrite it. If we used the title as the
// dedup key we'd tear down and remount the widget every few seconds (the
// "flickering" the user reported). The pathname is the only stable signal
// for "which conversation is open."
let widgetPath: string | null = null;

// Returns true only for 1:1 Direct Messages. Spaces / rooms / meeting
// chats live at /space/ or /room/ URLs and never get the widget.
function isDirectMessageUrl(path: string): boolean {
  return /\/dm\//.test(path);
}

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
  // Group DMs render as "Alice, Bob, Charlie - Chat" — comma → 3+ people,
  // not a 1:1 we can answer "está livre?" about.
  if (/,/.test(name)) return null;
  // Meeting-room chats look like "Atlas - 20 de mai." or "Standup #4".
  // Real people don't have digits or the word "reunião" in their names —
  // belt-and-suspenders backup for the URL check.
  if (/\d/.test(name)) return null;
  if (/\b(reuni[aã]o|meeting)\b/i.test(name)) return null;
  return name;
}

function reactToState(): void {
  // Two kill-switches stacked AND. widgetEnabled is the permanent
  // "never show" from settings; widgetOpen is the session-scoped
  // "closed for now" from the X button / home toggle. Either off → no
  // widget, and we proactively tear down any leftover mount.
  if (!widgetEnabled || !widgetOpen) {
    if (document.getElementById(WIDGET_ID)) {
      removeWidget();
      widgetPath = null;
    }
    return;
  }

  const path = location.pathname;
  const widgetExists = !!document.getElementById(WIDGET_ID);

  // Not in a DM → no widget, period.
  if (!isDirectMessageUrl(path)) {
    if (widgetExists) {
      removeWidget();
      widgetPath = null;
    }
    return;
  }

  // Same DM URL and widget already mounted → leave it alone. This is the
  // critical no-flicker path: it short-circuits on every tick even when
  // the title is briefly mutated by unread-counter updates, notifications,
  // or typing indicators in other conversations.
  if (widgetPath === path && widgetExists) return;

  // URL changed (or widget was torn down) — need to (re)mount. Read the
  // title now to know whose calendar to query.
  const name = currentConversationName();
  if (!name) {
    // Title hasn't settled yet (Chat sometimes shows "Google Chat"
    // momentarily during route changes). Don't tear down what we have —
    // wait for the next tick.
    if (widgetExists && widgetPath === path) return;
    return;
  }

  removeWidget();
  widgetPath = path;
  openWidget(name);
}

// MutationObserver setup + initial trigger live at the BOTTOM of the
// file (after `const WIDGET_HTML` is initialized) — otherwise the
// initial reactToState() call hits the temporal-dead-zone for that
// const and the widget throws on every tick.

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
  setInnerHTML(shadow, WIDGET_HTML);
  (document.documentElement || document.body).appendChild(host);

  const $ = <T extends Element = HTMLElement>(sel: string) =>
    shadow.querySelector(sel) as T;
  ($("#bc-name") as HTMLElement).textContent = name;
  ($(".bc-loading-text") as HTMLElement).textContent = pickLoadingPhrase();
  $<HTMLButtonElement>("#bc-close").addEventListener("click", () => {
    void closeWidgetForSession();
  });
  $<HTMLButtonElement>("#bc-min").addEventListener("click", () => {
    const root = shadow.querySelector("#bc-root") as HTMLElement | null;
    if (!root) return;
    const minimized = root.getAttribute("data-minimized") === "true";
    if (minimized) root.removeAttribute("data-minimized");
    else root.setAttribute("data-minimized", "true");
  });
  // Suppress event propagation so clicks inside the widget never trigger
  // Chat's own handlers.
  shadow
    .querySelector("#bc-root")
    ?.addEventListener("click", (e) => e.stopPropagation());

  void askBackend(name, shadow);
}

// Close = session-scoped suppression. The flag lives in chrome.storage.session
// so it clears on browser restart but persists across DM switches. The popup
// home view exposes the same flag via a switch — flipping it back to true
// re-mounts the widget on whichever Chat tab is open.
async function closeWidgetForSession(): Promise<void> {
  widgetOpen = false;
  widgetPath = null;
  removeWidget();
  try {
    await chrome.storage.session.set({ widgetOpen: false });
  } catch (err) {
    console.warn("[busy-checker] could not persist widgetOpen=false", err);
  }
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
  const busyTag = $("#bc-busy-tag") as HTMLElement;
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
    busyTag.hidden = !facts.meeting.busy;

    if (!facts.suggestedSlot) return;

    // === Slot navigation state ===
    // entries is one DayEntry per distinct day. Each day holds its known
    // free slots (loaded lazily as the user presses ↓) plus the day's
    // events. dayCursor selects the day; slotCursor selects which free
    // window within that day we're showing.
    type DayEntry = {
      slots: Slot[];
      events: CalendarEvent[];
      meetingsCount: number | null;
      fullyFetched: boolean;
    };
    const entries: DayEntry[] = [
      {
        slots: [facts.suggestedSlot],
        events: facts.eventsAround ?? [],
        meetingsCount: facts.meetingsToday,
        fullyFetched: false,
      },
    ];
    let dayCursor = 0;
    let slotCursor = 0;
    let currentSlot = entries[dayCursor].slots[slotCursor];
    let selectedDur = 30;
    let noMoreDays = false;
    let nextDayFetching = false;
    let intraFetching = false;

    const prevBtn = $<HTMLButtonElement>("#bc-day-prev");
    const nextBtn = $<HTMLButtonElement>("#bc-day-next");
    const upBtn = $<HTMLButtonElement>("#bc-slot-up");
    const downBtn = $<HTMLButtonElement>("#bc-slot-down");
    const dayCenter = $("#bc-day-center") as HTMLElement;
    const calMonth = $("#bc-cal-month") as HTMLElement;
    const calDay = $("#bc-cal-day") as HTMLElement;
    const hourEl = $("#bc-time-hour") as HTMLElement;
    const minEl = $("#bc-time-minute") as HTMLElement;
    const agendaEl = $("#bc-agenda") as HTMLElement;

    const sameSpDay = (a: Date, b: Date) =>
      a.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) ===
      b.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

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

    // Renders the agenda as a vertical timeline. Events are absolutely
    // positioned by start time, height is proportional to duration, and
    // overlapping events are laid out in side-by-side columns (like
    // Google Calendar). The suggested slot is a dashed block in
    // chronological position.
    const PX_PER_MIN = 0.85; // ~51 px per hour
    const WINDOW_RANGE_MS = 2.5 * 60 * 60 * 1000; // ±2.5h around slot
    const MIN_EVENT_HEIGHT = 16;
    const COMPACT_THRESHOLD = 28;
    const COLUMN_GAP_PX = 2;

    type LayoutItem = {
      kind: "event" | "slot";
      startMs: number;
      endMs: number;
      title: string;
      timeLabel: string;
    };

    // Greedy column assignment: each item goes into the leftmost column
    // whose last item has already ended. Returns column index + the max
    // number of columns active during this item's lifetime (which sets
    // how wide it should be rendered).
    const layoutColumns = (
      items: LayoutItem[],
    ): Array<{ item: LayoutItem; column: number; columns: number }> => {
      const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
      const colsLastEnd: number[] = []; // end time of last event placed in each column
      const assignments: number[] = new Array(sorted.length);
      for (let i = 0; i < sorted.length; i++) {
        const it = sorted[i];
        let col = colsLastEnd.findIndex((end) => end <= it.startMs);
        if (col === -1) {
          col = colsLastEnd.length;
          colsLastEnd.push(it.endMs);
        } else {
          colsLastEnd[col] = it.endMs;
        }
        assignments[i] = col;
      }
      // For each item compute the max column index among items overlapping
      // it — that's how many columns its row needs.
      return sorted.map((it, i) => {
        let maxCol = assignments[i];
        for (let j = 0; j < sorted.length; j++) {
          if (j === i) continue;
          const other = sorted[j];
          if (other.startMs < it.endMs && other.endMs > it.startMs) {
            maxCol = Math.max(maxCol, assignments[j]);
          }
        }
        return { item: it, column: assignments[i], columns: maxCol + 1 };
      });
    };

    const renderAgenda = (slot: Slot, events: CalendarEvent[]) => {
      const track = agendaEl.querySelector("#bc-agenda-track") as HTMLElement;
      // Clear previous content
      agendaEl
        .querySelectorAll(".bc-tl-line, .bc-tl-hour")
        .forEach((n) => n.remove());
      clearChildren(track);

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

      // "Now" line — visible only when the current time falls inside this
      // window (i.e., the agenda is showing today around now).
      const nowMs = Date.now();
      if (nowMs >= winStart && nowMs <= winEnd) {
        const topPx = ((nowMs - winStart) / 60000) * PX_PER_MIN;
        const nowLine = document.createElement("div");
        nowLine.className = "bc-tl-now";
        nowLine.style.top = `${topPx}px`;
        agendaEl.appendChild(nowLine);
      }

      // Build layout items — events + the suggested slot — clipped to window
      const items: LayoutItem[] = [];
      for (const ev of events) {
        const s = new Date(ev.start).getTime();
        const e = new Date(ev.end).getTime();
        const vs = Math.max(s, winStart);
        const ve = Math.min(e, winEnd);
        if (ve <= vs) continue;
        items.push({
          kind: "event",
          startMs: vs,
          endMs: ve,
          title: (ev.title ?? "").trim() || "(sem título)",
          timeLabel: formatTime(new Date(s)),
        });
      }
      const slotTitle = "Horário livre para agendamento";
      const slotEndClipped = Math.min(slotEndMs, winEnd);
      items.push({
        kind: "slot",
        startMs: slotStartMs,
        endMs: slotEndClipped,
        title: slotTitle,
        timeLabel: formatTime(new Date(slotStartMs)),
      });

      const positioned = layoutColumns(items);

      // 2px shaved off each block's bottom so consecutive events have a
      // clear visible seam (e.g., "10:00 ends" → "10:00 starts" reads as
      // two distinct events, not one taller one).
      const BLOCK_GAP_PX = 2;
      for (const { item, column, columns } of positioned) {
        const topPx = ((item.startMs - winStart) / 60000) * PX_PER_MIN;
        const heightPx = Math.max(
          MIN_EVENT_HEIGHT,
          ((item.endMs - item.startMs) / 60000) * PX_PER_MIN - BLOCK_GAP_PX,
        );
        const widthPct = 100 / columns;
        const leftPct = column * widthPct;
        const block = document.createElement("div");
        block.className =
          item.kind === "slot" ? "bc-ev bc-ev-slot" : "bc-ev";
        block.dataset.compact =
          heightPx < COMPACT_THRESHOLD ? "true" : "false";
        block.style.top = `${topPx}px`;
        block.style.height = `${heightPx}px`;
        block.style.left = `${leftPct}%`;
        block.style.width = `calc(${widthPct}% - ${columns > 1 ? COLUMN_GAP_PX : 0}px)`;
        if (item.kind === "event") {
          block.style.background = eventColor;
          block.style.color = eventTextColor;
        }
        setInnerHTML(
          block,
          `<span class="bc-ev-time"></span><span class="bc-ev-title"></span>`,
        );
        (block.querySelector(".bc-ev-time") as HTMLElement).textContent =
          item.timeLabel;
        (block.querySelector(".bc-ev-title") as HTMLElement).textContent =
          item.title;
        track.appendChild(block);
      }
    };

    const fadeAgendaTo = (slot: Slot, events: CalendarEvent[]) => {
      slotEl.dataset.fading = "true";
      window.setTimeout(() => {
        renderAgenda(slot, events);
        slotEl.dataset.fading = "false";
      }, 180);
    };

    const updateSideLabels = () => {
      const prev = entries[dayCursor - 1];
      const next = entries[dayCursor + 1];
      if (prev) {
        prevBtn.textContent = formatCalendarParts(
          new Date(prev.slots[0].start),
        ).weekday;
        prevBtn.disabled = false;
      } else {
        prevBtn.textContent = "";
        prevBtn.disabled = true;
      }
      if (next) {
        nextBtn.textContent = formatCalendarParts(
          new Date(next.slots[0].start),
        ).weekday;
        nextBtn.disabled = false;
      } else if (noMoreDays) {
        nextBtn.textContent = "—";
        nextBtn.disabled = true;
      } else {
        nextBtn.textContent = nextDayFetching ? "…" : "→";
        nextBtn.disabled = nextDayFetching;
      }
    };

    const updateIntraButtons = () => {
      const day = entries[dayCursor];
      upBtn.disabled = slotCursor === 0;
      // ↓ enabled if there's a cached next slot in this day OR we haven't
      // yet exhausted the day's slots.
      const hasCachedNext = slotCursor < day.slots.length - 1;
      downBtn.disabled =
        intraFetching || (!hasCachedNext && day.fullyFetched);
    };

    // How many days to keep cached AHEAD of the current cursor. Bigger →
    // smoother → button always finds data already in memory.
    const PREFETCH_LOOKAHEAD_DAYS = 3;

    // Fetches exactly one more day, anchored at the latest cached entry.
    const prefetchOneDay = async (): Promise<void> => {
      if (noMoreDays || nextDayFetching) return;
      nextDayFetching = true;
      updateSideLabels();
      try {
        // Anchor at the LAST cached entry's last known slot — not the
        // currently displayed slot — so successive prefetches chain
        // through future days instead of refetching the same one.
        const tail = entries[entries.length - 1];
        const tailSlot = tail.slots[tail.slots.length - 1];
        const after = nextSpDayMidnight(
          new Date(tailSlot.start),
        ).toISOString();
        const res = await chrome.runtime.sendMessage({
          type: "nextSlot",
          targetEmail: facts.targetEmail,
          after,
        });
        if (res?.ok) {
          const {
            slot,
            eventsAround: nextEvents,
            meetingsToday: nextCount,
          } = res.data as {
            slot: Slot | null;
            eventsAround: CalendarEvent[];
            meetingsToday: number | null;
          };
          if (slot) {
            entries.push({
              slots: [slot],
              events: nextEvents ?? [],
              meetingsCount: nextCount ?? null,
              fullyFetched: false,
            });
          } else {
            noMoreDays = true;
          }
        }
      } catch (err) {
        console.error("[busy-checker] prefetch failed", err);
      } finally {
        nextDayFetching = false;
        updateSideLabels();
      }
    };

    // Keeps fetching one day at a time until we have PREFETCH_LOOKAHEAD_DAYS
    // ahead of the current cursor, or we run out of slots.
    const prefetchUntilFull = async (): Promise<void> => {
      while (
        entries.length - 1 - dayCursor < PREFETCH_LOOKAHEAD_DAYS &&
        !noMoreDays
      ) {
        if (nextDayFetching) {
          // Another call is in flight; wait for it to finish then re-check.
          await new Promise<void>((resolve) => {
            const tick = () =>
              nextDayFetching ? setTimeout(tick, 30) : resolve();
            tick();
          });
          continue;
        }
        await prefetchOneDay();
      }
    };

    // Backwards-compatible alias for older call sites
    const prefetchNextDay = prefetchUntilFull;

    // Tries to fetch the next free slot AFTER the current day's last
    // known slot. If it lands on the same day, append it. If it lands on
    // a different day, mark the current day as fully fetched (and also
    // cache that next-day entry so ← → already know what's there).
    const fetchNextIntraSlot = async (): Promise<Slot | null> => {
      const day = entries[dayCursor];
      if (day.fullyFetched || intraFetching) return null;
      intraFetching = true;
      updateIntraButtons();
      const dayStart = new Date(day.slots[0].start);
      const lastEnd = day.slots[day.slots.length - 1].end;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "nextSlot",
          targetEmail: facts.targetEmail,
          after: lastEnd,
        });
        if (!res?.ok) throw new Error(res?.error ?? "unknown");
        const {
          slot,
          eventsAround: evs,
          meetingsToday: count,
        } = res.data as {
          slot: Slot | null;
          eventsAround: CalendarEvent[];
          meetingsToday: number | null;
        };
        if (!slot) {
          day.fullyFetched = true;
          noMoreDays = true;
          return null;
        }
        if (sameSpDay(new Date(slot.start), dayStart)) {
          day.slots.push(slot);
          return slot;
        }
        // Different day → cache as next-day entry (saves a roundtrip when
        // user later clicks →) and mark current day done.
        day.fullyFetched = true;
        if (!entries[dayCursor + 1]) {
          entries.push({
            slots: [slot],
            events: evs ?? [],
            meetingsCount: count ?? null,
            fullyFetched: false,
          });
        }
        return null;
      } catch (err) {
        console.error("[busy-checker] intra fetch failed", err);
        return null;
      } finally {
        intraFetching = false;
        updateIntraButtons();
        updateSideLabels();
      }
    };

    const renderCurrent = (animateTime = false) => {
      const day = entries[dayCursor];
      const slot = day.slots[slotCursor];
      const events = day.events;

      // Badge reflects the currently-viewed day's meeting count, not
      // today's. Hidden when count is unknown for that day.
      if (day.meetingsCount === null || day.meetingsCount === undefined) {
        meetingsBadge.hidden = true;
      } else {
        meetingsBadge.hidden = false;
        meetingsCount.textContent = String(day.meetingsCount);
      }

      const fromTime = animateTime ? displayedTime : null;
      currentSlot = slot;
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      const gapMin = Math.floor((end.getTime() - start.getTime()) / 60000);

      if (fromTime) {
        animateTimeTo(fromTime, start);
        fadeAgendaTo(slot, events);
      } else {
        if (timeAnimHandle !== null) cancelAnimationFrame(timeAnimHandle);
        writeClock(start);
        writeDate(start);
        displayedTime = start;
        renderAgenda(slot, events);
      }

      // Duration chips for the schedule form (capped to gap size)
      const validDurations = DURATION_OPTIONS_MIN.filter((m) => m <= gapMin);
      if (validDurations.length === 0) validDurations.push(gapMin);
      if (!validDurations.includes(selectedDur)) {
        selectedDur = validDurations.includes(30) ? 30 : validDurations[0];
      }
      clearChildren(durRow);
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
      updateIntraButtons();
      // Pre-fetch the next day's first slot so the side label is ready
      // before the user clicks →.
      void prefetchNextDay();
    };

    const flashSlot = (direction: "next" | "prev") => {
      slotEl.removeAttribute("data-flash");
      void (slotEl as HTMLElement).offsetWidth;
      slotEl.dataset.flash = direction;
    };

    prevBtn.addEventListener("click", () => {
      if (dayCursor === 0 || prevBtn.disabled) return;
      dayCursor--;
      slotCursor = 0;
      flashSlot("prev");
      renderCurrent(true);
    });

    nextBtn.addEventListener("click", async () => {
      if (nextBtn.disabled) return;
      if (dayCursor < entries.length - 1) {
        dayCursor++;
        slotCursor = 0;
        flashSlot("next");
        renderCurrent(true);
        return;
      }
      if (noMoreDays) return;
      await prefetchNextDay();
      if (entries[dayCursor + 1]) {
        dayCursor++;
        slotCursor = 0;
        flashSlot("next");
        renderCurrent(true);
      }
    });

    upBtn.addEventListener("click", () => {
      if (upBtn.disabled || slotCursor === 0) return;
      slotCursor--;
      renderCurrent(true);
    });

    downBtn.addEventListener("click", async () => {
      if (downBtn.disabled) return;
      const day = entries[dayCursor];
      if (slotCursor < day.slots.length - 1) {
        slotCursor++;
        renderCurrent(true);
        return;
      }
      const next = await fetchNextIntraSlot();
      if (next) {
        slotCursor++;
        renderCurrent(true);
      }
    });

    slotEl.hidden = false;
    scheduleBtn.hidden = false;
    titleInput.value = `Conversa com ${name}`;
    renderCurrent();

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
        setInnerHTML(success, parts.join(" · "));
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
  #bc-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  #bc-name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  #bc-busy-tag {
    background: #dc2626;
    color: #ffffff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 999px;
    flex-shrink: 0;
    line-height: 1.2;
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
  #bc-close,
  #bc-min {
    background: none;
    border: 0;
    color: #9ca3af;
    cursor: pointer;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  #bc-close { font-size: 18px; padding: 2px 6px; }
  #bc-close:hover,
  #bc-min:hover { background: #f3f4f6; color: #374151; }
  #bc-min svg { width: 12px; height: 12px; transition: transform 0.2s ease; }
  #bc-root[data-minimized="true"] #bc-min svg { transform: rotate(180deg); }

  /* === Minimized state — hide body + meta, show kanji prefix === */
  #bc-min-kanji {
    font-family: "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP",
      "Noto Serif CJK JP", "MS Mincho", "Songti SC", serif;
    font-size: 18px;
    color: #111827;
    font-weight: 500;
    line-height: 1;
    letter-spacing: -0.02em;
    flex-shrink: 0;
  }
  #bc-root:not([data-minimized="true"]) #bc-min-kanji { display: none; }
  #bc-root[data-minimized="true"] #bc-body { display: none; }
  #bc-root[data-minimized="true"] #bc-header {
    border-bottom: 0;
    padding: 10px 12px;
  }
  #bc-root[data-minimized="true"] #bc-email,
  #bc-root[data-minimized="true"] #bc-busy-tag,
  #bc-root[data-minimized="true"] #bc-meetings-badge { display: none; }
  #bc-root[data-minimized="true"] #bc-name {
    font-size: 13px;
    font-weight: 500;
  }
  #bc-root[data-minimized="true"] {
    width: auto;
    min-width: 220px;
  }
  /* The "thinking" loading state already hides #bc-header — minimize is
     only meaningful once we've rendered. Force header back in if both
     somehow flip on at the same time. */
  #bc-root[data-state="thinking"][data-minimized="true"] #bc-header {
    display: flex;
  }
  #bc-root[data-state="thinking"][data-minimized="true"] #bc-loading {
    display: none;
  }

  #bc-body { padding: 10px 12px 12px; }

  /* === Loading state (compact: hides header, single thin row) === */
  #bc-root[data-state="thinking"] #bc-header { display: none; }
  #bc-root[data-state="thinking"] #bc-body { padding: 0; }
  #bc-root[data-state="thinking"] {
    width: auto;
    min-width: 220px;
  }

  #bc-loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    animation: bc-loading-in 0.3s ease-out;
  }
  @keyframes bc-loading-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  #bc-root[data-state="ok"] #bc-loading,
  #bc-root[data-state="error"] #bc-loading {
    display: none;
  }
  .bc-loading-kanji {
    font-family: "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP",
      "Noto Serif CJK JP", "MS Mincho", "Songti SC", serif;
    font-size: 20px;
    color: #111827;
    font-weight: 500;
    line-height: 1;
    flex-shrink: 0;
    letter-spacing: -0.02em;
  }
  .bc-loading-text {
    flex: 1;
    font-size: 11.5px;
    color: #6b7280;
    font-style: italic;
    letter-spacing: -0.01em;
    line-height: 1.3;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bc-loading-spinner {
    width: 12px;
    height: 12px;
    color: #9ca3af;
    flex-shrink: 0;
    animation: bc-spin 2.5s linear infinite;
    transform-origin: center;
  }
  @keyframes bc-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

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
    margin-top: 0;
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
    margin-bottom: 6px;
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
    margin: 2px 0 8px;
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

  /* Flip-clock cards (HH MM) + intra-day chevron navigation */
  #bc-clock-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #bc-flip-clock {
    display: flex;
    gap: 5px;
    flex-shrink: 0;
  }
  #bc-slot-intra {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bc-chev {
    background: transparent;
    border: 1px solid #e5e7eb;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    padding: 0;
    color: #6b7280;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.08s;
  }
  .bc-chev svg { width: 12px; height: 12px; display: block; }
  .bc-chev:hover:not(:disabled) {
    background: #f3f4f6;
    color: #111827;
    border-color: #d1d5db;
  }
  .bc-chev:active:not(:disabled) { transform: scale(0.92); }
  .bc-chev:disabled { opacity: 0.3; cursor: not-allowed; }
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
  }
  #bc-slot[data-fading="true"] #bc-agenda { opacity: 0; }

  /* Events are positioned in % within this track so overlapping events
     can share the width by splitting into columns. */
  #bc-agenda-track {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 30px;
    right: 4px;
  }

  .bc-tl-line {
    position: absolute;
    left: 30px;
    right: 4px;
    height: 1px;
    background: rgba(0,0,0,0.05);
  }
  .bc-tl-hour {
    position: absolute;
    left: 4px;
    width: 24px;
    font-size: 9px;
    color: #9ca3af;
    font-variant-numeric: tabular-nums;
    transform: translateY(-50%);
    letter-spacing: -0.02em;
  }
  .bc-tl-now {
    position: absolute;
    left: 28px;
    right: 4px;
    height: 0;
    border-top: 1.5px solid #f97316;
    z-index: 3;
    pointer-events: none;
  }
  .bc-tl-now::before {
    content: "";
    position: absolute;
    left: -4px;
    top: -4px;
    width: 6.5px;
    height: 6.5px;
    border-radius: 50%;
    background: #f97316;
  }

  .bc-ev {
    position: absolute;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }
  /* Comfortable: two-line layout with time on top, title below */
  .bc-ev[data-compact="false"] {
    padding: 3px 7px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .bc-ev[data-compact="false"] .bc-ev-time {
    font-size: 10px;
    opacity: 0.85;
    line-height: 1.1;
  }
  .bc-ev[data-compact="false"] .bc-ev-title {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  /* Compact: short events get a single inline line "10am Title" */
  .bc-ev[data-compact="true"] {
    padding: 2px 6px;
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .bc-ev[data-compact="true"] .bc-ev-time {
    font-size: 9px;
    font-weight: 600;
    opacity: 0.85;
    flex-shrink: 0;
  }
  .bc-ev[data-compact="true"] .bc-ev-title {
    font-size: 10px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .bc-ev-time {
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" on;
    letter-spacing: -0.02em;
  }
  .bc-ev-title {
    letter-spacing: -0.01em;
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
    <span id="bc-min-kanji" aria-hidden="true">時</span>
    <div id="bc-header-text">
      <div id="bc-name-row">
        <span id="bc-name"></span>
        <span id="bc-busy-tag" hidden>ocupado</span>
      </div>
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
    <button id="bc-min" aria-label="minimizar" title="minimizar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
    <button id="bc-close" aria-label="fechar" title="fechar">×</button>
  </div>
  <div id="bc-body">
    <div id="bc-loading">
      <span class="bc-loading-kanji">時</span>
      <span class="bc-loading-text"></span>
      <svg class="bc-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    </div>
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
        <div id="bc-clock-wrap">
          <div id="bc-flip-clock" aria-hidden="true">
            <div class="bc-flip-card" id="bc-time-hour"></div>
            <div class="bc-flip-card" id="bc-time-minute"></div>
          </div>
          <div id="bc-slot-intra">
            <button id="bc-slot-up" class="bc-chev" type="button" disabled aria-label="slot anterior do dia">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
            </button>
            <button id="bc-slot-down" class="bc-chev" type="button" aria-label="próximo slot do dia">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
          </div>
        </div>
      </div>
      <div id="bc-agenda"><div id="bc-agenda-track"></div></div>
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

// Bootstrap — moved here so WIDGET_HTML is already initialized before
// reactToState() can fire on a tab that already has a conversation open.
//
// We watch document.head (where <title> lives) instead of the whole
// document. Watching the full subtree with characterData fired on every
// keystroke in the chat input — even with the early-return in
// reactToState this triggered visible flicker because typing rewrote a
// lot of DOM around the message composer. The head subtree only mutates
// when the title or other meta updates, which is exactly what we care
// about for navigation cues.
const obs = new MutationObserver(reactToState);
obs.observe(document.head, {
  subtree: true,
  childList: true,
  characterData: true,
});
// Some title rewrites happen via assigning to document.title rather than
// mutating the existing <title> node — Chrome's MutationObserver covers
// both, but History API pushes don't fire popstate, so the periodic
// fallback below catches URL changes that slip past everything else.
window.addEventListener("popstate", reactToState);

// Seed both flags from storage before the first reactToState tick.
// If the user has the widget off, this prevents a brief flash of the
// loading card on tab open.
Promise.all([
  getSettings().catch(() => DEFAULT_SETTINGS),
  chrome.storage.session
    .get("widgetOpen")
    .catch(() => ({ widgetOpen: undefined } as { widgetOpen?: unknown })),
])
  .then(([s, sess]) => {
    widgetEnabled = s.widgetEnabled;
    widgetOpen =
      typeof (sess as { widgetOpen?: unknown }).widgetOpen === "boolean"
        ? ((sess as { widgetOpen: boolean }).widgetOpen)
        : true;
    reactToState();
  })
  .catch(() => reactToState());

// React live to popup toggles — no F5 needed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const next = (changes.settings.newValue ?? {}) as Partial<Settings>;
    const enabled =
      typeof next.widgetEnabled === "boolean"
        ? next.widgetEnabled
        : DEFAULT_SETTINGS.widgetEnabled;
    if (enabled !== widgetEnabled) {
      widgetEnabled = enabled;
      reactToState();
    }
    return;
  }
  if (area === "session" && changes.widgetOpen) {
    const nextOpen =
      typeof changes.widgetOpen.newValue === "boolean"
        ? changes.widgetOpen.newValue
        : true;
    if (nextOpen !== widgetOpen) {
      widgetOpen = nextOpen;
      reactToState();
    }
  }
});

setInterval(reactToState, 2000);
