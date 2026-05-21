/// <reference types="chrome" />
// Asker-configurable preferences. Stored in chrome.storage.local so both
// the popup and the chat content script see the same values.

export type Settings = {
  workStartHour: number; // inclusive, 0-23
  workEndHour: number; // exclusive, 1-24
  eventColor: string; // hex (#rrggbb) — applied uniformly to all preview events
};

export const DEFAULT_SETTINGS: Settings = {
  workStartHour: 9,
  workEndHour: 18,
  eventColor: "#3b82f6",
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const s = (settings ?? {}) as Partial<Settings>;
  return {
    workStartHour: clamp(s.workStartHour ?? DEFAULT_SETTINGS.workStartHour, 0, 23),
    workEndHour: clamp(s.workEndHour ?? DEFAULT_SETTINGS.workEndHour, 1, 24),
    eventColor: validHex(s.eventColor) ? s.eventColor! : DEFAULT_SETTINGS.eventColor,
  };
}

function validHex(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
}

export async function setSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: next });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
