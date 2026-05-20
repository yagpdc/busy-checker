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
    | {
        busy: true;
        kind: "meeting" | "outOfOffice" | "focusTime";
        title: string | null;
        endsAt: Date;
      };
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
    const ends = facts.meeting.endsAt.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    let phrase: string;
    if (facts.meeting.kind === "outOfOffice") {
      phrase = "está fora do escritório (Ausente)";
    } else if (facts.meeting.kind === "focusTime") {
      phrase = "está em foco";
    } else if (facts.meeting.title) {
      phrase = `está em "${facts.meeting.title}"`;
    } else {
      phrase = "está em reunião";
    }
    return `${facts.targetEmail} ${phrase} até ${ends}.${suggestion}`;
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

// formatStatusReply was removed intentionally. Replies must come from
// templateStatusReply (deterministic, free). OpenAI is reserved for
// parseQuestion above, and only fires when the user types a free-form
// question in the popup that isn't an email or a plain name.
