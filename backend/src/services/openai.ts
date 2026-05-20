// THE ONLY file in the backend that talks to OpenAI.
//
// One single call site: `parseQuestion`. It's gated upstream in
// routes/query.ts to fire only when the popup receives a free-form text
// that isn't an email and isn't a plain name. The chat widget never
// reaches this path (it sends targetName directly).

import OpenAI from "openai";
import { config } from "../config.js";

export const openaiEnabled = config.openai.apiKey !== null;

const client = openaiEnabled
  ? new OpenAI({ apiKey: config.openai.apiKey! })
  : null;

function requireClient(): OpenAI {
  if (!client) throw new Error("openai_not_configured");
  return client;
}

export type ParsedQuestion = {
  targetEmail: string | null;
  targetHint: string | null;
};

/**
 * Pulls a target email (or a name hint) out of a free-form question.
 * Kept narrow on purpose — directory resolution is the caller's job.
 */
export async function parseQuestion(
  question: string,
): Promise<ParsedQuestion> {
  const resp = await requireClient().chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Extract who the user is asking about. Return JSON: ' +
          '{"targetEmail": string|null, "targetHint": string|null}. ' +
          "targetEmail only if an email literal appears in the question. " +
          "targetHint is the person's name or other identifier otherwise.",
      },
      { role: "user", content: question },
    ],
  });
  const raw = resp.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw) as Partial<ParsedQuestion>;
    return {
      targetEmail: parsed.targetEmail ?? null,
      targetHint: parsed.targetHint ?? null,
    };
  } catch {
    return { targetEmail: null, targetHint: null };
  }
}
