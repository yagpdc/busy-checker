// Deterministic reply formatter. NO OpenAI / network / token spend here.
// If you ever need to change how status messages read, this is the only file
// that needs editing. openai.ts is reserved for actual API calls.

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
  outsideWorkingHours: boolean;
  workingHours: { start: number; end: number };
};

/**
 * Is `when` outside the configured working window in São Paulo time?
 * Weekends count as outside.
 */
export function isOutsideWorkingHours(
  when: Date,
  workStartHour: number,
  workEndHour: number,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(when);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = parseInt(hourStr === "24" ? "0" : hourStr, 10);
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = dowMap[weekday] ?? -1;
  if (dow === 0 || dow === 6) return true;
  return hour < workStartHour || hour >= workEndHour;
}

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
  if (facts.outsideWorkingHours) {
    const { start, end } = facts.workingHours;
    return `${facts.targetEmail} está fora do horário de trabalho (${pad(start)}h–${pad(end)}h).${suggestion}`;
  }
  return `${facts.targetEmail} está disponível agora.`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
