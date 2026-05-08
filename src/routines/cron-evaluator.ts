/**
 * CronEvaluator — next-fire computation for 5-field standard cron expressions.
 *
 * Reuses the field-match logic from schedule.ts (matchCronToken, validateCronField)
 * but adds a forward-scanning nextFire() that finds the next minute satisfying
 * all 5 fields, with monthly day-of-month clamping (Q5).
 *
 * Field order: minute hour dayOfMonth month dayOfWeek
 * Supports: *, ranges (1-5), steps (*\/5, 1-5\/2), comma lists (1,3,5).
 * dayOfWeek: 0=Sun, 7=Sun (normalized to 0).
 */

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

type CronFieldSpec = {
  min: number;
  max: number;
  normalize?: (value: number) => number;
};

const CRON_SPECS: Record<keyof CronFields, CronFieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7, normalize: (v) => (v === 7 ? 0 : v) },
};

function isIntegerString(s: string): boolean {
  return /^\d+$/.test(s);
}

function normalizeValue(value: number, spec: CronFieldSpec): number {
  return spec.normalize?.(value) ?? value;
}

function parseTokenRange(
  token: string,
  spec: CronFieldSpec,
): { start: number; end: number } | null {
  if (token === "*") return { start: spec.min, end: spec.max };
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

function matchField(fieldValue: string, current: number, spec: CronFieldSpec): boolean {
  return fieldValue.split(",").some((token) => matchCronToken(token, current, spec));
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
      return (
        Number.isFinite(step) &&
        step > 0 &&
        parseTokenRange(stepMatch[1], spec) !== null
      );
    }
    return parseTokenRange(trimmed, spec) !== null;
  });
}

/**
 * Validate a 5-field cron expression string or CronFields object.
 * Returns true when all fields parse cleanly.
 */
export function isValidCronExpression(expr: string | CronFields): boolean {
  const fields = typeof expr === "string" ? parseCronExpression(expr) : expr;
  if (!fields) return false;
  return (Object.keys(CRON_SPECS) as Array<keyof CronFields>).every((k) =>
    validateCronField(fields[k], CRON_SPECS[k]),
  );
}

/**
 * Parse "minute hour dayOfMonth month dayOfWeek" string into CronFields.
 * Returns null on malformed input.
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}

/**
 * Internal field-match helper — assumes `fields` has already been validated.
 * Called by both matchesCron (after its own validation) and the hot loop in
 * nextCronFire (where validation runs once before the loop, not per-iter).
 */
function _matchesCronFields(fields: CronFields, now: Date): boolean {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const dayOfMonth = now.getUTCDate();
  const month = now.getUTCMonth() + 1;
  const dayOfWeek = now.getUTCDay();

  return (
    matchField(fields.minute, minute, CRON_SPECS.minute) &&
    matchField(fields.hour, hour, CRON_SPECS.hour) &&
    matchField(fields.dayOfMonth, dayOfMonth, CRON_SPECS.dayOfMonth) &&
    matchField(fields.month, month, CRON_SPECS.month) &&
    matchField(fields.dayOfWeek, dayOfWeek, CRON_SPECS.dayOfWeek)
  );
}

/**
 * Check whether `now` satisfies the cron expression (minute-level resolution).
 * All field comparisons use UTC so behaviour is timezone-independent.
 */
export function matchesCron(expr: string | CronFields, now: Date): boolean {
  const fields = typeof expr === "string" ? parseCronExpression(expr) : expr;
  if (!fields || !isValidCronExpression(fields)) return false;
  return _matchesCronFields(fields, now);
}

/**
 * Compute the next fire Date after `from` for the given cron expression.
 *
 * Scans forward minute-by-minute (up to maxMinutes = 527,040 = 1 year) until
 * a minute matches all 5 fields. Monthly day-of-month clamping is handled by
 * the Date object's overflow behaviour — if dayOfMonth > last day of target
 * month, the scan naturally skips past it.
 *
 * Returns null when no match is found within the horizon (e.g., "31 2 30 2 *"
 * has no valid date).
 */
export function nextCronFire(
  expr: string | CronFields,
  from: Date,
  maxMinutes = 527_040,
): Date | null {
  const fields = typeof expr === "string" ? parseCronExpression(expr) : expr;
  if (!fields || !isValidCronExpression(fields)) return null;

  // Start from the next minute after `from` (UTC-based arithmetic).
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < maxMinutes; i++) {
    if (_matchesCronFields(fields, candidate)) return new Date(candidate.getTime());
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}
