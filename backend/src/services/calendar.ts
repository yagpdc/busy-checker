import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type MeetingKind = "meeting" | "outOfOffice" | "focusTime";

export type MeetingStatus =
  | { busy: false }
  | { busy: true; kind: MeetingKind; title: string | null; endsAt: Date };

function eventKind(eventType: string | null | undefined): MeetingKind {
  if (eventType === "outOfOffice") return "outOfOffice";
  if (eventType === "focusTime") return "focusTime";
  return "meeting";
}

// Working-location events are informational and don't block time.
function blocksTime(ev: { transparency?: string | null; status?: string | null; eventType?: string | null }): boolean {
  if (ev.transparency === "transparent") return false;
  if (ev.status === "cancelled") return false;
  if (ev.eventType === "workingLocation") return false;
  return true;
}

/**
 * Checks whether `targetEmail` is currently in a meeting. Uses the
 * requester's OAuth client. In Workspace, FreeBusy works across colleagues;
 * meeting titles are only returned when the target's calendar is readable.
 */
export async function currentMeeting(
  asker: OAuth2Client,
  targetEmail: string,
  now: Date = new Date(),
): Promise<MeetingStatus> {
  const calendar = google.calendar({ version: "v3", auth: asker });

  // Look an hour ahead so we can report when the current meeting ends.
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

  // Try events.list first — gives us titles + eventType (so we can tell
  // "out of office" apart from "meeting").
  try {
    const { data } = await calendar.events.list({
      calendarId: targetEmail,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });
    const active = (data.items ?? []).find((ev) => {
      if (!blocksTime(ev)) return false;
      const start = ev.start?.dateTime ?? ev.start?.date;
      const end = ev.end?.dateTime ?? ev.end?.date;
      if (!start || !end) return false;
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      return startMs <= now.getTime() && endMs > now.getTime();
    });
    if (!active) return { busy: false };
    const endIso = active.end?.dateTime ?? active.end?.date!;
    return {
      busy: true,
      kind: eventKind(active.eventType),
      title: active.summary ?? null,
      endsAt: new Date(endIso),
    };
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 403 && code !== 404) throw err;
    // No event-detail access — fall back to FreeBusy (no titles, no kind).
  }

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: targetEmail }],
    },
  });
  const busies = fb.data.calendars?.[targetEmail]?.busy ?? [];
  const active = busies.find((b) => {
    if (!b.start || !b.end) return false;
    return (
      new Date(b.start).getTime() <= now.getTime() &&
      new Date(b.end).getTime() > now.getTime()
    );
  });
  if (!active) return { busy: false };
  return {
    busy: true,
    kind: "meeting",
    title: null,
    endsAt: new Date(active.end!),
  };
}

/**
 * Finds the next gap of `minDurationMin` minutes on `targetEmail`'s calendar
 * within working hours, skipping weekends. TZ defaults to São Paulo (UTC-3).
 */
export async function nextFreeSlot(
  asker: OAuth2Client,
  targetEmail: string,
  options: {
    minDurationMin?: number;
    lookAheadDays?: number;
    workStartHour?: number;
    workEndHour?: number;
    tzOffsetHours?: number;
  } = {},
  now: Date = new Date(),
): Promise<{ start: Date; end: Date } | null> {
  const minDurMs = (options.minDurationMin ?? 30) * 60 * 1000;
  const lookAheadDays = options.lookAheadDays ?? 5;
  const workStart = options.workStartHour ?? 9;
  const workEnd = options.workEndHour ?? 18;
  const tz = options.tzOffsetHours ?? -3;

  const calendar = google.calendar({ version: "v3", auth: asker });
  const timeMin = now.toISOString();
  const timeMax = new Date(
    now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Prefer events.list — it surfaces OOO/eventType correctly. FreeBusy
  // sometimes underreports OOO blocks, leading us to suggest slots during
  // someone's away period. Fall back to FreeBusy if event-detail access
  // is denied.
  let busy: { start: number; end: number }[] = [];
  try {
    const { data } = await calendar.events.list({
      calendarId: targetEmail,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    busy = (data.items ?? [])
      .filter(blocksTime)
      .map((ev) => {
        const s = ev.start?.dateTime ?? ev.start?.date;
        const e = ev.end?.dateTime ?? ev.end?.date;
        if (!s || !e) return null;
        return { start: new Date(s).getTime(), end: new Date(e).getTime() };
      })
      .filter((x): x is { start: number; end: number } => x !== null)
      .sort((a, b) => a.start - b.start);
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 403 && code !== 404) throw err;
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: targetEmail }] },
    });
    busy = (fb.data.calendars?.[targetEmail]?.busy ?? [])
      .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
      .map((b) => ({
        start: new Date(b.start).getTime(),
        end: new Date(b.end).getTime(),
      }))
      .sort((a, b) => a.start - b.start);
  }

  // Build working windows in target TZ for the next N days, skipping weekends.
  const earliest = now.getTime() + 5 * 60 * 1000; // 5min buffer from now
  for (let i = 0; i < lookAheadDays; i++) {
    const dayUtc = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    // Shift into target TZ so getUTC* returns target-local components.
    const local = new Date(dayUtc.getTime() + tz * 60 * 60 * 1000);
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) continue;

    const winStart = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      workStart - tz,
      0,
      0,
    );
    const winEnd = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      workEnd - tz,
      0,
      0,
    );

    let pointer = Math.max(winStart, earliest);
    if (pointer >= winEnd) continue;

    const overlapping = busy.filter((b) => b.end > pointer && b.start < winEnd);
    for (const b of overlapping) {
      if (b.start - pointer >= minDurMs) {
        // end = full extent of the free gap (capped at the next busy event)
        // so the UI can offer durations up to that.
        return {
          start: new Date(pointer),
          end: new Date(b.start),
        };
      }
      pointer = Math.max(pointer, b.end);
      if (pointer >= winEnd) break;
    }
    if (winEnd - pointer >= minDurMs) {
      return {
        start: new Date(pointer),
        end: new Date(winEnd),
      };
    }
  }

  return null;
}

export type CalendarEventLite = {
  start: string;
  end: string;
  title: string | null;
};

/**
 * Lists `targetEmail`'s blocking events around `center`, with titles
 * when available. Used to draw a Google-Calendar-style agenda preview.
 * Falls back to FreeBusy (no titles) when event-detail access is denied.
 */
export async function eventsAround(
  asker: OAuth2Client,
  targetEmail: string,
  center: Date,
  rangeMs: number = 3 * 60 * 60 * 1000,
): Promise<CalendarEventLite[]> {
  const calendar = google.calendar({ version: "v3", auth: asker });
  const timeMin = new Date(center.getTime() - rangeMs).toISOString();
  const timeMax = new Date(center.getTime() + rangeMs).toISOString();

  try {
    const { data } = await calendar.events.list({
      calendarId: targetEmail,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });
    return (data.items ?? [])
      .filter(blocksTime)
      .map((ev): CalendarEventLite | null => {
        const s = ev.start?.dateTime ?? ev.start?.date;
        const e = ev.end?.dateTime ?? ev.end?.date;
        if (!s || !e) return null;
        return {
          start: new Date(s).toISOString(),
          end: new Date(e).toISOString(),
          title: ev.summary ?? null,
        };
      })
      .filter((x): x is CalendarEventLite => x !== null);
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 403 && code !== 404) throw err;
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: targetEmail }] },
    });
    return (fb.data.calendars?.[targetEmail]?.busy ?? [])
      .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
      .map((b) => ({ start: b.start, end: b.end, title: null }));
  }
}

/**
 * Counts the target's blocking meetings today (SP day bounds). Returns
 * null when calendar isn't readable. Excludes all-day events (typically
 * OOO/holidays — not meetings).
 */
export async function meetingsTodayCount(
  asker: OAuth2Client,
  targetEmail: string,
  now: Date = new Date(),
  tzOffsetHours = -3,
): Promise<number | null> {
  const sp = new Date(now.getTime() + tzOffsetHours * 60 * 60 * 1000);
  const dayStartMs = Date.UTC(
    sp.getUTCFullYear(),
    sp.getUTCMonth(),
    sp.getUTCDate(),
    -tzOffsetHours,
    0,
    0,
  );
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const calendar = google.calendar({ version: "v3", auth: asker });
  try {
    const { data } = await calendar.events.list({
      calendarId: targetEmail,
      timeMin: new Date(dayStartMs).toISOString(),
      timeMax: new Date(dayEndMs).toISOString(),
      singleEvents: true,
      maxResults: 50,
    });
    return (data.items ?? [])
      .filter(blocksTime)
      .filter((ev) => !!ev.start?.dateTime) // exclude all-day
      .length;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 403 && code !== 404) throw err;
    // FreeBusy fallback: just count intervals (not perfect, no all-day filter)
    try {
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: new Date(dayStartMs).toISOString(),
          timeMax: new Date(dayEndMs).toISOString(),
          items: [{ id: targetEmail }],
        },
      });
      return (fb.data.calendars?.[targetEmail]?.busy ?? []).length;
    } catch {
      return null;
    }
  }
}

/**
 * Creates an event on the asker's primary calendar with the target as
 * invitee and a Meet link attached. Returns the Calendar URL + Meet URL.
 */
export async function scheduleMeeting(
  asker: OAuth2Client,
  targetEmail: string,
  start: Date,
  end: Date,
  title: string,
): Promise<{ htmlLink: string; meetLink: string | null }> {
  const calendar = google.calendar({ version: "v3", auth: asker });
  const res = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    conferenceDataVersion: 1,
    requestBody: {
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email: targetEmail }],
      conferenceData: {
        createRequest: {
          requestId: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });
  const meetLink =
    res.data.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video",
    )?.uri ?? null;
  return { htmlLink: res.data.htmlLink ?? "", meetLink };
}
