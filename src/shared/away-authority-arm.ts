/**
 * Renderer-safe wire contract for arming and disarming the away answerer.
 *
 * This module deliberately carries no policy. Every bound on a legal grant —
 * which tool categories may be armed, how long, how many calls, and what a
 * directory scope must survive — lives in `parseAwayAuthorityGrant`, and this
 * file must never restate one. What it does own is the SHAPE the desk may put
 * on the wire, which is a smaller thing: a preset instead of a raw number, a
 * mode instead of a category list.
 *
 * Presets rather than raw values because the renderer is untrusted input like
 * any other cross-boundary caller. A `ttlMs` field would let a caller ask for a
 * lifetime nobody chose from a menu; a preset can only name one of four
 * durations the owner was actually shown.
 *
 * `mode` rather than `categories` for the same reason and one more: `write` is
 * the consequential half of this feature, and a two-option mode makes arming it
 * a distinct choice with its own label rather than one checkbox among several.
 * The mode → category mapping lives in the IPC handler, next to the only other
 * place that names those literals.
 */
import { hasUserKeyboardIntent, type UserKeyboardIntent } from "./chat-origin.js";
import { hasExactKeys } from "./is-record.js";
import { isNonNegativeSafeInteger } from "./safe-integer.js";

/**
 * Offered lifetimes. The longest is the ceiling `parseAwayAuthorityGrant`
 * enforces, not a value chosen here — a preset longer than that ceiling would
 * simply fail to arm, so the menu stops where the policy does.
 */
export const AWAY_AUTHORITY_DURATION_PRESETS = ["30m", "1h", "2h", "4h"] as const;
export type AwayAuthorityDurationPreset = (typeof AWAY_AUTHORITY_DURATION_PRESETS)[number];

/** Offered call budgets, ending at the same ceiling for the same reason. */
export const AWAY_AUTHORITY_BUDGET_PRESETS = [5, 10, 25, 50] as const;
export type AwayAuthorityBudgetPreset = (typeof AWAY_AUTHORITY_BUDGET_PRESETS)[number];

/**
 * What the desk is arming, in the owner's terms. `read-write` includes reads:
 * a write-only grant would refuse every read the same turn needs, so it is not
 * a state the owner can mean.
 */
const AWAY_AUTHORITY_MODES = ["read-only", "read-write"] as const;
export type AwayAuthorityMode = (typeof AWAY_AUTHORITY_MODES)[number];

/**
 * Wire ceiling on the directory list. Not a policy bound — the sanitizer
 * decides which directories survive — but a cross-boundary payload bound, so a
 * caller cannot hand the sanitizer an unbounded array.
 */
export const AWAY_AUTHORITY_MAX_DIRECTORIES = 16;
const MAX_DIRECTORY_CHARS = 4096;
/** Cross-boundary bound on the tile name, which main looks up and never parses. */
const MAX_CHAT_GROUP_ID_CHARS = 128;

const AWAY_AUTHORITY_ERROR_CODES = [
  "unauthorized",
  "unauthorized-frame",
  "away-authority-disabled",
  "user-keyboard-required",
  "away-authority-input-invalid",
  "away-authority-operation-rejected",
  "away-authority-unavailable",
] as const;
type AwayAuthorityErrorCode = (typeof AWAY_AUTHORITY_ERROR_CODES)[number];

export interface AwayAuthorityArmInputPayload {
  readonly intent: UserKeyboardIntent;
  /**
   * The TILE the owner is arming, not the conversation in it.
   *
   * The main area can hold several conversations at once, so "the open one" is
   * no longer a fact main can resolve — it would arm whichever conversation the
   * primary loop happened to hold, which is the wrong one for every other tile.
   * A group id still cannot name a conversation the owner is not looking at:
   * main reads what that tile holds AT EXECUTION, and refuses a group the
   * window is not showing.
   */
  readonly chatGroupId: string;
  readonly mode: AwayAuthorityMode;
  readonly directories: readonly string[];
  readonly duration: AwayAuthorityDurationPreset;
  readonly budget: AwayAuthorityBudgetPreset;
}

export interface AwayAuthorityIntentOnlyInput {
  readonly intent: UserKeyboardIntent;
}

/**
 * What the desk is shown about a live grant.
 *
 * `writable` rather than the raw category list: the desk asks one question of
 * an armed grant, and projecting the answer in main keeps the category literals
 * out of the renderer entirely.
 *
 * `remaining` is what is left, not what was asked for — the snapshot has no
 * memory of the original budget, and inventing one for display would be a
 * number no code enforces.
 */
export interface AwayAuthorityStatus {
  readonly writable: boolean;
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly remaining: number;
}

type AwayAuthorityFailure = {
  readonly ok: false;
  readonly error: AwayAuthorityErrorCode;
};

export type AwayAuthorityMutationResult =
  | { readonly ok: true }
  | AwayAuthorityFailure;

/**
 * `status: null` means nothing is armed RIGHT NOW, which is not the same
 * question as "does a grant object exist". Main answers the first one; see the
 * handler for why an expired grant is reported as nothing armed.
 */
export type AwayAuthorityStatusResult =
  | { readonly ok: true; readonly status: AwayAuthorityStatus | null }
  | AwayAuthorityFailure;

/**
 * The only away-authority surface exposed to the trusted Electron renderer.
 * Both mutations carry a preload-minted live keyboard intent, and neither names
 * a conversation: arming names a TILE, and main reads what that tile is holding
 * when the mutation runs.
 */
export interface AwayAuthorityOwnerApi {
  status(): Promise<AwayAuthorityStatusResult>;
  arm(input: {
    chatGroupId: string;
    mode: AwayAuthorityMode;
    directories: readonly string[];
    duration: AwayAuthorityDurationPreset;
    budget: AwayAuthorityBudgetPreset;
  }): Promise<AwayAuthorityMutationResult>;
  disarm(): Promise<AwayAuthorityMutationResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAwayAuthorityMode(value: unknown): value is AwayAuthorityMode {
  return typeof value === "string" && (AWAY_AUTHORITY_MODES as readonly string[]).includes(value);
}

function isAwayAuthorityDurationPreset(
  value: unknown,
): value is AwayAuthorityDurationPreset {
  return typeof value === "string"
    && (AWAY_AUTHORITY_DURATION_PRESETS as readonly string[]).includes(value);
}

function isAwayAuthorityBudgetPreset(value: unknown): value is AwayAuthorityBudgetPreset {
  return typeof value === "number"
    && (AWAY_AUTHORITY_BUDGET_PRESETS as readonly number[]).includes(value);
}

function isDirectoryList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= AWAY_AUTHORITY_MAX_DIRECTORIES
    && value.every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= MAX_DIRECTORY_CHARS);
}

/**
 * Shape only. Whether these directories may be armed is the sanitizer's
 * question, and whether this mode's categories are armable is
 * `parseAwayAuthorityGrant`'s; a payload that passes here can still be refused
 * by either, which is the intended division.
 */
export function isAwayAuthorityArmInput(value: unknown): value is AwayAuthorityArmInputPayload {
  return record(value)
    && hasExactKeys(value, ["budget", "chatGroupId", "directories", "duration", "intent", "mode"])
    && hasUserKeyboardIntent(value.intent)
    && typeof value.chatGroupId === "string"
    && value.chatGroupId.trim().length > 0
    && value.chatGroupId.length <= MAX_CHAT_GROUP_ID_CHARS
    && isAwayAuthorityMode(value.mode)
    && isDirectoryList(value.directories)
    && isAwayAuthorityDurationPreset(value.duration)
    && isAwayAuthorityBudgetPreset(value.budget);
}

export function isAwayAuthorityIntentOnlyInput(
  value: unknown,
): value is AwayAuthorityIntentOnlyInput {
  return record(value) && hasExactKeys(value, ["intent"]) && hasUserKeyboardIntent(value.intent);
}

function isAwayAuthorityErrorCode(value: unknown): value is AwayAuthorityErrorCode {
  return typeof value === "string"
    && (AWAY_AUTHORITY_ERROR_CODES as readonly string[]).includes(value);
}

export function parseAwayAuthorityStatus(value: unknown): AwayAuthorityStatus | null {
  if (!record(value)
    || !hasExactKeys(value, ["directories", "expiresAt", "remaining", "writable"])
    || typeof value.writable !== "boolean"
    || !Array.isArray(value.directories)
    || value.directories.length > AWAY_AUTHORITY_MAX_DIRECTORIES
    || !value.directories.every((entry) => typeof entry === "string" && entry.length > 0)
    || !isNonNegativeSafeInteger(value.expiresAt)
    || typeof value.remaining !== "number"
    || !Number.isSafeInteger(value.remaining)
    || value.remaining <= 0) {
    return null;
  }
  return Object.freeze({
    writable: value.writable,
    directories: Object.freeze([...value.directories] as string[]),
    expiresAt: value.expiresAt,
    remaining: value.remaining,
  });
}

function parseAwayAuthorityFailure(value: unknown): AwayAuthorityFailure | null {
  if (!record(value) || !hasExactKeys(value, ["error", "ok"])
    || value.ok !== false || !isAwayAuthorityErrorCode(value.error)) {
    return null;
  }
  return Object.freeze({ ok: false, error: value.error });
}

/** Rebuild the result projection so unknown IPC fields never cross preload. */
export function parseAwayAuthorityMutationResult(
  value: unknown,
): AwayAuthorityMutationResult | null {
  const failure = parseAwayAuthorityFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !hasExactKeys(value, ["ok"]) || value.ok !== true) return null;
  return Object.freeze({ ok: true });
}

export function parseAwayAuthorityStatusResult(value: unknown): AwayAuthorityStatusResult | null {
  const failure = parseAwayAuthorityFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !hasExactKeys(value, ["ok", "status"]) || value.ok !== true) return null;
  if (value.status === null) return Object.freeze({ ok: true, status: null });
  const status = parseAwayAuthorityStatus(value.status);
  return status === null ? null : Object.freeze({ ok: true, status });
}
