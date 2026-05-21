// THE ONLY file in the backend that talks to OpenAI.
//
// Two call sites, both gated upstream from routes/query.ts so the chat
// widget never spends tokens (it sends a targetName directly):
//  - parseQuestion: extracts a person hint/email from a free-form question
//  - answerQuestion: multi-turn conversational answer grounded in the
//    facts JSON; receives the prior conversation history

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

export type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * Pulls a target hint/email out of the latest user message, using the prior
 * conversation as context — so "qual o horário do Silva?" after the assistant
 * listed multiple "Mateus" candidates can still resolve to Mateus Silva.
 *
 * Returns ParsedQuestion with one or both of email/hint, or both null when
 * the user isn't naming anyone (in which case the route falls back to the
 * currently-resolved target from session context).
 */
export async function parseQuestion(
  question: string,
  history: ChatMessage[] = [],
): Promise<ParsedQuestion> {
  const trimmed = history.slice(-8);
  const resp = await requireClient().chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Extract who the user is asking about in the LATEST message. ' +
          'Return JSON: {"targetEmail": string|null, "targetHint": string|null}. ' +
          "targetEmail only if a literal email appears. " +
          "targetHint is the person's name or distinguishing word (e.g. " +
          '"Silva" when previously the assistant offered "Mateus Silva" and ' +
          '"Mateus Costa"). Combine with prior turns when the new message ' +
          "is short/partial. Both null if no person is referenced (pronoun " +
          'follow-up like "e amanhã?").',
      },
      ...trimmed,
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

/**
 * Multi-turn answer in PT-BR grounded in the JSON context. Receives the
 * prior conversation so follow-ups have memory of who was discussed.
 * Context may include calendar facts (target resolved) or a `candidates`
 * list (disambiguation needed) — the system prompt directs the model how
 * to handle each.
 */
export async function answerQuestion(
  question: string,
  context: Record<string, unknown>,
  history: ChatMessage[] = [],
): Promise<string> {
  const trimmed = history.slice(-12);
  const resp = await requireClient().chat.completions.create({
    model: config.openai.model,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          "Você é o Toki, um assistente de agenda da Driva. Responde em " +
          "português do Brasil, no máximo 3 frases curtas, direto e " +
          'conversacional. Mantém o contexto: o usuário pode usar "ele/ela" ' +
          "referindo-se à pessoa já mencionada.\n\n" +
          "Use APENAS os fatos do JSON de contexto — não invente horários, " +
          "reuniões nem detalhes. Horários estão em America/Sao_Paulo.\n\n" +
          "Se o contexto incluir `candidates` (lista de pessoas com nomes " +
          "parecidos), liste-as numeradas e pergunte qual o usuário quer. Se " +
          "vier `events`, use títulos/horários pra contextualizar (ex: 'ele " +
          "tem Daily às 15h30'). Se a info pedida não está no contexto, diga " +
          "educadamente. Use o primeiro nome da pessoa.",
      },
      ...trimmed,
      {
        role: "user",
        content:
          `${question}\n\n` +
          `Contexto (JSON):\n${JSON.stringify(context, null, 2)}`,
      },
    ],
  });
  return (
    resp.choices[0]?.message?.content?.trim() ??
    "Não consegui responder com os dados disponíveis."
  );
}
