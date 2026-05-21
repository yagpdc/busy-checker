import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type DirectoryCandidate = {
  email: string;
  name: string | null;
};

/**
 * Look up Workspace people by display name. Returns all candidates so the
 * caller (or the assistant model) can disambiguate. Empty array on miss.
 */
export async function searchDirectory(
  asker: OAuth2Client,
  nameHint: string,
): Promise<DirectoryCandidate[]> {
  const people = google.people({ version: "v1", auth: asker });
  try {
    const res = await people.people.searchDirectoryPeople({
      query: nameHint,
      readMask: "emailAddresses,names",
      sources: ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
      pageSize: 10,
    });
    const matches = res.data.people ?? [];
    const seen = new Set<string>();
    const out: DirectoryCandidate[] = [];
    for (const p of matches) {
      const email = p.emailAddresses?.[0]?.value;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({
        email,
        name: p.names?.[0]?.displayName ?? null,
      });
    }
    return out;
  } catch (err) {
    console.error("directory search failed", err);
    return [];
  }
}

/**
 * Backwards-compatible single-best-match resolver. Returns null when there's
 * either no match or genuine ambiguity. Used as a fast path — callers that
 * want to surface candidates to the user should call `searchDirectory`
 * directly.
 */
export async function findEmailInDirectory(
  asker: OAuth2Client,
  nameHint: string,
): Promise<string | null> {
  const candidates = await searchDirectory(asker, nameHint);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].email;
  // Multiple: only auto-resolve if exactly one is an exact case-insensitive
  // name match. Otherwise let the caller disambiguate.
  const needle = nameHint.trim().toLowerCase();
  const exact = candidates.filter(
    (c) => (c.name ?? "").trim().toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0].email;
  return null;
}
