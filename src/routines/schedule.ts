export interface HeartbeatSchedule {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export const HEARTBEAT_AGENT_OPTIONS = [
  {
    id: "monitor",
    label: "Monitor",
    description: "캘린더/메일/미팅 컨텍스트를 조용히 갱신합니다.",
    defaultPrompt: "현재 proactive 컨텍스트를 조용히 갱신하고, 중요한 변화가 있더라도 과도한 요약은 하지 마세요.",
  },
  {
    id: "briefing",
    label: "Briefing",
    description: "짧은 업무 pulse 브리핑을 생성합니다.",
    defaultPrompt: "현재 시점의 업무 pulse를 2~4문장 한국어로 요약하세요. 긴급 항목을 먼저, 불필요한 수식 없이 간결하게 작성하세요.",
  },
  {
    id: "follow-up",
    label: "Follow-up",
    description: "후속 액션과 놓친 항목을 점검합니다.",
    defaultPrompt: "현재 놓치면 안 되는 후속 작업, 응답 필요 메일, 임박 일정만 간결하게 정리하세요. 바로 행동 가능한 항목을 우선하세요.",
  },
] as const;

export type HeartbeatAgentId = typeof HEARTBEAT_AGENT_OPTIONS[number]["id"];

export interface HeartbeatEntry {
  id: string;
  enabled: boolean;
  agentId: HeartbeatAgentId;
  schedule: HeartbeatSchedule;
  prompt: string;
}

export const MAX_HEARTBEAT_ENTRIES = 5;

export const DEFAULT_HEARTBEAT_SCHEDULE: HeartbeatSchedule = {
  minute: "*/15",
  hour: "*",
  dayOfMonth: "*",
  month: "*",
  dayOfWeek: "*",
};

export const DEFAULT_HEARTBEAT_AGENT_ID: HeartbeatAgentId = "monitor";
export const DEFAULT_WAKEUP_PROMPT =
  "오늘 반드시 챙겨야 할 업무 맥락, 긴급 메일, 임박한 일정, 회의 후속조치를 우선순위 중심으로 간결하게 정리하세요.";
export const DEFAULT_SHUTDOWN_PROMPT =
  "오늘 마무리 시점에서 남은 후속 작업, 중요한 결정, 내일 이어서 볼 포인트를 중심으로 정리하세요.";

type CronFieldSpec = {
  min: number;
  max: number;
  normalize?: (value: number) => number;
};

const CRON_FIELD_SPECS: Record<keyof HeartbeatSchedule, CronFieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) },
};

function isIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

function normalizeCronField(
  value: unknown,
  field: keyof HeartbeatSchedule,
): string {
  if (typeof value !== "string") return DEFAULT_HEARTBEAT_SCHEDULE[field];
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_HEARTBEAT_SCHEDULE[field];
}

function normalizeValue(value: number, spec: CronFieldSpec): number {
  const normalized = spec.normalize?.(value) ?? value;
  return normalized;
}

function parseTokenRange(token: string, spec: CronFieldSpec): { start: number; end: number } | null {
  if (token === "*") {
    return { start: spec.min, end: spec.max };
  }
  if (isIntegerString(token)) {
    const point = normalizeValue(Number.parseInt(token, 10), spec);
    if (point < spec.min || point > spec.max) return null;
    return { start: point, end: point };
  }
  const match = /^(\d+)-(\d+)$/.exec(token);
  if (!match) return null;
  const start = normalizeValue(Number.parseInt(match[1], 10), spec);
  const end = normalizeValue(Number.parseInt(match[2], 10), spec);
  if (start < spec.min || end > spec.max || start > end) return null;
  return { start, end };
}

function matchCronToken(token: string, current: number, spec: CronFieldSpec): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(trimmed);
  if (stepMatch) {
    const step = Number.parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) return false;
    const range = parseTokenRange(stepMatch[1], spec);
    if (!range) return false;
    if (current < range.start || current > range.end) return false;
    return (current - range.start) % step === 0;
  }
  const range = parseTokenRange(trimmed, spec);
  if (!range) return false;
  return current >= range.start && current <= range.end;
}

function validateCronField(fieldValue: string, spec: CronFieldSpec): boolean {
  const tokens = fieldValue.split(",");
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const trimmed = token.trim();
    if (!trimmed) return false;
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(trimmed);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[2], 10);
      return Number.isFinite(step) && step > 0 && parseTokenRange(stepMatch[1], spec) !== null;
    }
    return parseTokenRange(trimmed, spec) !== null;
  });
}

export function normalizeHeartbeatSchedule(
  value: Partial<HeartbeatSchedule> | null | undefined,
): HeartbeatSchedule {
  return {
    minute: normalizeCronField(value?.minute, "minute"),
    hour: normalizeCronField(value?.hour, "hour"),
    dayOfMonth: normalizeCronField(value?.dayOfMonth, "dayOfMonth"),
    month: normalizeCronField(value?.month, "month"),
    dayOfWeek: normalizeCronField(value?.dayOfWeek, "dayOfWeek"),
  };
}

export function isValidHeartbeatSchedule(
  value: Partial<HeartbeatSchedule> | null | undefined,
): boolean {
  const schedule = normalizeHeartbeatSchedule(value);
  return (Object.keys(schedule) as Array<keyof HeartbeatSchedule>).every((field) =>
    validateCronField(schedule[field], CRON_FIELD_SPECS[field]),
  );
}

export function heartbeatScheduleToCron(
  value: Partial<HeartbeatSchedule> | null | undefined,
): string {
  const schedule = normalizeHeartbeatSchedule(value);
  return [
    schedule.minute,
    schedule.hour,
    schedule.dayOfMonth,
    schedule.month,
    schedule.dayOfWeek,
  ].join(" ");
}

export function isHeartbeatAgentId(value: unknown): value is HeartbeatAgentId {
  return HEARTBEAT_AGENT_OPTIONS.some((option) => option.id === value);
}

export function getHeartbeatAgentOption(agentId: HeartbeatAgentId) {
  return HEARTBEAT_AGENT_OPTIONS.find((option) => option.id === agentId) ?? HEARTBEAT_AGENT_OPTIONS[0];
}

export function getDefaultHeartbeatPrompt(agentId: HeartbeatAgentId): string {
  return getHeartbeatAgentOption(agentId).defaultPrompt;
}

export function normalizeHeartbeatAgentId(value: unknown): HeartbeatAgentId {
  return isHeartbeatAgentId(value) ? value : DEFAULT_HEARTBEAT_AGENT_ID;
}

export function createHeartbeatEntryId(seed?: number): string {
  if (typeof seed === "number" && Number.isFinite(seed) && seed >= 0) {
    return `heartbeat-${seed + 1}`;
  }
  return `heartbeat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultHeartbeatEntry(seed = 0): HeartbeatEntry {
  return {
    id: createHeartbeatEntryId(seed),
    enabled: true,
    agentId: DEFAULT_HEARTBEAT_AGENT_ID,
    schedule: { ...DEFAULT_HEARTBEAT_SCHEDULE },
    prompt: getDefaultHeartbeatPrompt(DEFAULT_HEARTBEAT_AGENT_ID),
  };
}

export function normalizeHeartbeatEntry(
  value: Partial<HeartbeatEntry> | null | undefined,
  seed = 0,
): HeartbeatEntry {
  const record = value && typeof value === "object" ? value : {};
  const id = typeof record.id === "string" && record.id.trim().length > 0
    ? record.id.trim()
    : createHeartbeatEntryId(seed);
  const agentId = normalizeHeartbeatAgentId(record.agentId);
  const prompt = typeof record.prompt === "string" && record.prompt.trim().length > 0
    ? record.prompt.trim()
    : getDefaultHeartbeatPrompt(agentId);
  return {
    id,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    agentId,
    schedule: normalizeHeartbeatSchedule(record.schedule),
    prompt,
  };
}

export function normalizeHeartbeatEntries(
  value: unknown,
  legacySchedule?: Partial<HeartbeatSchedule> | null,
): HeartbeatEntry[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, MAX_HEARTBEAT_ENTRIES).map((entry, index) =>
      normalizeHeartbeatEntry(entry as Partial<HeartbeatEntry>, index)
    );
  }
  if (legacySchedule) {
    return [{
      ...createDefaultHeartbeatEntry(0),
      schedule: normalizeHeartbeatSchedule(legacySchedule),
    }];
  }
  return [createDefaultHeartbeatEntry(0)];
}

export function isValidHeartbeatEntries(value: unknown): value is HeartbeatEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HEARTBEAT_ENTRIES) return false;
  const ids = new Set<string>();
  return value.every((entry, index) => {
    const normalized = normalizeHeartbeatEntry(entry as Partial<HeartbeatEntry>, index);
    if (ids.has(normalized.id)) return false;
    ids.add(normalized.id);
    return isValidHeartbeatSchedule(normalized.schedule) && normalized.prompt.trim().length > 0;
  });
}

function getKstParts(now: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number.parseInt(map.year ?? "0", 10),
    month: Number.parseInt(map.month ?? "0", 10),
    day: Number.parseInt(map.day ?? "0", 10),
    hour: Number.parseInt(map.hour ?? "0", 10),
    minute: Number.parseInt(map.minute ?? "0", 10),
    dayOfWeek: weekdayMap[map.weekday ?? "Sun"] ?? 0,
  };
}

export function getKstMinuteKey(now: Date): string {
  const parts = getKstParts(now);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function matchesHeartbeatSchedule(
  value: Partial<HeartbeatSchedule> | null | undefined,
  now: Date,
): boolean {
  const schedule = normalizeHeartbeatSchedule(value);
  if (!isValidHeartbeatSchedule(schedule)) return false;
  const current = getKstParts(now);
  return (
    schedule.minute.split(",").some((token) => matchCronToken(token, current.minute, CRON_FIELD_SPECS.minute)) &&
    schedule.hour.split(",").some((token) => matchCronToken(token, current.hour, CRON_FIELD_SPECS.hour)) &&
    schedule.dayOfMonth.split(",").some((token) => matchCronToken(token, current.day, CRON_FIELD_SPECS.dayOfMonth)) &&
    schedule.month.split(",").some((token) => matchCronToken(token, current.month, CRON_FIELD_SPECS.month)) &&
    schedule.dayOfWeek.split(",").some((token) => matchCronToken(token, current.dayOfWeek, CRON_FIELD_SPECS.dayOfWeek))
  );
}
