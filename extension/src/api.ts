import { API_BASE } from "./config.js";
export { API_BASE };

export async function getSession(): Promise<string | null> {
  const { session } = await chrome.storage.local.get("session");
  return (session as string | undefined) ?? null;
}

export async function setSession(session: string): Promise<void> {
  await chrome.storage.local.set({ session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(["session", "user"]);
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const session = await getSession();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (session) headers.set("authorization", `Bearer ${session}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}
