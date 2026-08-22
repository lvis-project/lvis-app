/**
 * Accepting one field of a settings block — the shape both settings paths share.
 *
 * Reading a profile off disk and applying a patch from the renderer ask the
 * same question of every field: is this value the right shape? A value that is
 * absent is simply not stored and says nothing; a value of the wrong shape is a
 * hand-edited profile or a misbehaving caller, and it earns exactly one warning
 * naming the field and the value that stands instead of it.
 *
 * That was written out per field — around thirty near-identical blocks across
 * `settings-normalization.ts` and `settings-store.ts` whose only real variation
 * is the shape test. Being written out is what let the field name in a warning
 * drift from the field being validated, and it is why every new setting arrives
 * as another eight-line copy. It is one function now, and the field name in the
 * message is derived from the field being assigned rather than retyped.
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("settings");

/**
 * Which of the two situations rejected the value — they differ in what stands
 * instead, so they say different things.
 */
export interface FieldRejection {
  /** What was wrong, from the caller's point of view. */
  readonly reason: string;
  /** What holds now: the shipped default, or the value already in effect. */
  readonly verb: string;
}

/** A value read from the settings file. What stands instead is the default. */
export const STORED_FIELD: FieldRejection = Object.freeze({
  reason: "invalid",
  verb: "using default",
});

/** A value from an update patch. What stands instead is the live setting. */
export const PATCHED_FIELD: FieldRejection = Object.freeze({
  reason: "patch ignored",
  verb: "keeping",
});

/**
 * Assign `raw` to `target[key]` when it has the right shape.
 *
 * `target` must already hold the value that stands if `raw` is rejected — both
 * callers build it that way (`{ ...DEFAULT_SETTINGS.system }` when reading,
 * `{ ...this.settings.system }` when patching), which is what lets the warning
 * report the value actually in effect rather than a second guess at it.
 */
export function acceptField<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: unknown,
  accept: (value: unknown) => boolean,
  block: string,
  rejection: FieldRejection,
): void {
  acceptNormalizedField(
    target,
    key,
    raw,
    (value) => (accept(value) ? (value as T[K]) : undefined),
    block,
    rejection,
  );
}

/**
 * {@link acceptField} for the fields whose validation is a TRANSFORM rather
 * than a shape test — a width that is clamped to its pane range, a timeout that
 * is floored and bounded. `normalize` returns the value to store, or
 * `undefined` to reject.
 *
 * These were the blocks {@link acceptField} could not absorb, and they were
 * left written out for exactly one turn before this file grew a second copy of
 * the surrounding if/else/warn. It is the same three sentences either way, so
 * the shape test is now just the transform that returns its input unchanged.
 */
export function acceptNormalizedField<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: unknown,
  normalize: (value: unknown) => T[K] | undefined,
  block: string,
  rejection: FieldRejection,
): void {
  const normalized = normalize(raw);
  if (normalized !== undefined) {
    target[key] = normalized;
    return;
  }
  // Absent is not invalid: it is the ordinary case of a setting nobody has
  // written yet, and warning about it would make a clean profile look broken.
  if (raw === undefined) return;
  log.warn(
    `${block}.${String(key)} ${rejection.reason} (received ${JSON.stringify(raw)}), ${rejection.verb} %s`,
    target[key],
  );
}

/** The shape test for the boolean settings, which are most of them. */
export function isBooleanValue(value: unknown): boolean {
  return typeof value === "boolean";
}
