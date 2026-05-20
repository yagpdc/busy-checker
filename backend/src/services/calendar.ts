import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type MeetingStatus =
  | { busy: false }
  | { busy: true; title: string | null; endsAt: Date };

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

  // Try events.list first — gives us the title when accessible.
  try {
    const { data } = await calendar.events.list({
      calendarId: targetEmail,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 5,
    });
    const active = (data.items ?? []).find((ev) => {
      if (ev.transparency === "transparent") return false;
      if (ev.status === "cancelled") return false;
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
      title: active.summary ?? null,
      endsAt: new Date(endIso),
    };
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code !== 403 && code !== 404) throw err;
    // No event-detail access — fall back to FreeBusy (no titles).
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
  return { busy: true, title: null, endsAt: new Date(active.end!) };
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

  const fb = await calendar.freebusy.query({
    requestBody: { timeMin, timeMax, items: [{ id: targetEmail }] },
  });

  const busy = (fb.data.calendars?.[targetEmail]?.busy ?? [])
    .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
    .map((b) => ({
      start: new Date(b.start).getTime(),
      end: new Date(b.end).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

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
        return {
          start: new Date(pointer),
          end: new Date(pointer + minDurMs),
        };
      }
      pointer = Math.max(pointer, b.end);
      if (pointer >= winEnd) break;
    }
    if (winEnd - pointer >= minDurMs) {
      return {
        start: new Date(pointer),
        end: new Date(pointer + minDurMs),
      };
    }
  }

  return null;
}
