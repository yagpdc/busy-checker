import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    redirectUri: required("GOOGLE_REDIRECT_URI"),
    allowedHd: process.env.ALLOWED_HD || null,
  },
  openai: {
    apiKey:
      process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "PREENCHER"
        ? process.env.OPENAI_API_KEY
        : null,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  },
  sessionSecret: required("SESSION_JWT_SECRET"),
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  presenceWindowSec: 60,
} as const;
