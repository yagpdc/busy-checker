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
