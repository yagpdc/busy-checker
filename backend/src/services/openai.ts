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

export type StatusFacts = {
  targetEmail: string;
  online: boolean;
  lastActivityAt: Date | null;
  meeting:
    | { busy: false }
    | { busy: true; title: string | null; endsAt: Date };
  suggestedSlot: { start: Date; end: Date } | null;
};

function formatSlot(slot: { start: Date; end: Date }, now: Date): string {
  const tz = "America/Sao_Paulo";
  const sameDay =
    slot.start.toLocaleDateString("pt-BR", { timeZone: tz }) ===
    now.toLocaleDateString("pt-BR", { timeZone: tz });
  const time = slot.start.toLocaleTimeString("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `hoje às ${time}`;
  const day = slot.start.toLocaleDateString("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  return `${day} às ${time}`;
}

export function templateStatusReply(facts: StatusFacts): string {
  const now = new Date();
  const suggestion = facts.suggestedSlot
    ? ` Próxima janela livre: ${formatSlot(facts.suggestedSlot, now)}.`
    : "";

  if (facts.meeting.busy) {
    const ends = facts.meeting.endsAt.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
    });
    const title = facts.meeting.title
      ? ` em "${facts.meeting.title}"`
      : " em reunião";
    return `${facts.targetEmail} está${title} até ${ends}.${suggestion}`;
  }
  if (facts.online) return `${facts.targetEmail} está disponível agora.`;
  if (facts.lastActivityAt) {
    const ago = Math.floor(
      (Date.now() - facts.lastActivityAt.getTime()) / 60000,
    );
    return `${facts.targetEmail} sem atividade no navegador há ~${ago} min.${suggestion}`;
  }
  return `${facts.targetEmail} sem reunião agora, mas sem sinal de presença (talvez não tenha a extensão instalada).${suggestion}`;
}

export async function formatStatusReply(
  question: string,
  facts: StatusFacts,
): Promise<string> {
  const resp = await requireClient().chat.completions.create({
    model: config.openai.model,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You answer questions about someone's current availability in 1-2 short Portuguese sentences. " +
          "Be direct. If they're in a meeting and a title is available, mention it. " +
          "If a title isn't available, just say they're in a meeting until <time>. " +
          'If they\'re online and not in a meeting, say "disponível". ' +
          'If they\'re offline (no recent activity) and not in a meeting, say "offline / sem atividade recente". ' +
          "If a suggestedSlot is provided (meaning they're not available right now), append a short sentence like " +
          '"Próxima janela livre: hoje às HH:MM." Format the time in Brazilian Portuguese using America/Sao_Paulo time.',
      },
      {
        role: "user",
        content:
          `Pergunta: ${question}\n` +
          `Fatos: ${JSON.stringify({
            ...facts,
            lastActivityAt: facts.lastActivityAt?.toISOString() ?? null,
            meeting:
              facts.meeting.busy
                ? { ...facts.meeting, endsAt: facts.meeting.endsAt.toISOString() }
                : facts.meeting,
          })}`,
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() ?? "Não consegui responder.";
}
