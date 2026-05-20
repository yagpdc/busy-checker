import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/**
 * Look up a Workspace email by display name using the People API directory
 * search. Returns null if the hint matches 0 results or multiple ambiguous
 * ones with no exact name match.
 */
export async function findEmailInDirectory(
  asker: OAuth2Client,
  nameHint: string,
): Promise<string | null> {
  const people = google.people({ version: "v1", auth: asker });
  try {
    const res = await people.people.searchDirectoryPeople({
      query: nameHint,
      readMask: "emailAddresses,names",
      sources: ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
      pageSize: 10,
    });
    const matches = res.data.people ?? [];
    if (matches.length === 0) return null;

    // Single match: trust it.
    if (matches.length === 1) {
      return matches[0].emailAddresses?.[0]?.value ?? null;
    }

    // Multiple matches: only resolve if exactly one has an exact-name match
    // (case-insensitive). Otherwise we'd guess wrong.
    const needle = nameHint.trim().toLowerCase();
    const exact = matches.filter((p) =>
      (p.names ?? []).some(
        (n) => n.displayName?.trim().toLowerCase() === needle,
      ),
    );
    if (exact.length === 1) {
      return exact[0].emailAddresses?.[0]?.value ?? null;
    }
    return null;
  } catch (err) {
    console.error("directory search failed", err);
    return null;
  }
}
