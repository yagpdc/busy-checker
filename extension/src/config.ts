// Build-time config baked into the extension. The Client ID is public
// (only the Client SECRET — kept on the backend — is sensitive). When the
// backend moves off localhost, update API_BASE and rebuild.
export const GOOGLE_CLIENT_ID =
  "347210332088-3r0bup2t6rn71dlqrvrnf6v45jfan1sm.apps.googleusercontent.com";

export const API_BASE = "http://localhost:8787";
