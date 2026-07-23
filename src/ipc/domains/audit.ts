/**
 * Audit domain IPC handlers.
 * Covers: lvis:audit:*, lvis:dlp:*
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import type { AuditSearchFilter } from "../../audit/audit-logger.js";
import {
  auditUnauthorized,
  UNAUTHORIZED_FRAME,
  validateHostRendererSender,
} from "../gated.js";
import type { IpcDeps } from "../types.js";

const MAX_AUDIT_SEARCH_LIMIT = 500;
const MAX_AUDIT_SEARCH_OFFSET = 1_000_000;
const MAX_AUDIT_TEXT_LENGTH = 512;
const MAX_AUDIT_TYPE_LENGTH = 64;
const MAX_AUDIT_STATS_DAYS = 3_660;
const SEARCH_KEYS = new Set(["dateFrom", "dateTo", "type", "textSearch", "limit", "offset"]);

function invalidInput(message: string): TypeError {
  return new TypeError(`invalid audit IPC input: ${message}`);
}

function parseIsoDate(value: unknown, field: "dateFrom" | "dateTo"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidInput(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalidInput(`${field} must be a real calendar date`);
  }
  return value;
}

function parseBoundedInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function parseOptionalString(
  value: unknown,
  field: string,
  maximumLength: number,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength || (pattern && !pattern.test(value))) {
    throw invalidInput(`${field} is malformed or exceeds ${maximumLength} characters`);
  }
  return value;
}

function parseAuditSearchFilter(input: unknown): AuditSearchFilter {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput("search filter must be an object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SEARCH_KEYS.has(key)) throw invalidInput(`unknown search field: ${key}`);
  }

  const dateFrom = parseIsoDate(record.dateFrom, "dateFrom");
  const dateTo = parseIsoDate(record.dateTo, "dateTo");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw invalidInput("dateFrom must not be later than dateTo");
  }

  return {
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(record.type !== undefined
      ? { type: parseOptionalString(record.type, "type", MAX_AUDIT_TYPE_LENGTH, /^[a-z][a-z0-9_:-]*$/)! }
      : {}),
    ...(record.textSearch !== undefined
      ? { textSearch: parseOptionalString(record.textSearch, "textSearch", MAX_AUDIT_TEXT_LENGTH)! }
      : {}),
    limit: parseBoundedInteger(record.limit, "limit", 100, 1, MAX_AUDIT_SEARCH_LIMIT),
    offset: parseBoundedInteger(record.offset, "offset", 0, 0, MAX_AUDIT_SEARCH_OFFSET),
  };
}

function parseAuditStatsDays(input: unknown): number {
  return parseBoundedInteger(input, "days", 7, 1, MAX_AUDIT_STATS_DAYS);
}

export function registerAuditHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(CHANNELS.audit.search, async (event, input: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.audit.search, event);
      return UNAUTHORIZED_FRAME;
    }
    return auditLogger.search(parseAuditSearchFilter(input));
  });

  ipcMain.handle(CHANNELS.audit.stats, async (event, input: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.audit.stats, event);
      return UNAUTHORIZED_FRAME;
    }
    return auditLogger.getStats(parseAuditStatsDays(input));
  });

  ipcMain.handle(CHANNELS.dlp.stats, async (event, input: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.dlp.stats, event);
      return UNAUTHORIZED_FRAME;
    }
    const { getDlpStats } = await import("../../audit/dlp-stats.js");
    return getDlpStats(parseAuditStatsDays(input));
  });
}
