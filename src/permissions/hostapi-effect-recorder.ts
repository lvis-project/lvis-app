/**
 * Structural hostApi effect recorder — the SINGLE recording point for the
 * effect-boundary observability model.
 *
 * The host asserts `hostObservable:true` for every in-process plugin tool, so
 * every host-mediated effect a plugin tool produces must be observable on the
 * per-invocation {@link EffectLedger}. Per-closure manual `recordChokepoint`
 * calls kept missing methods across review rounds (storage → auth → conversation
 * → openAuthPartitionViewer / agentApproval.request / callLlm / registerKeywords).
 * An un-instrumented MUTATING method yields an empty ledger and is recorded as a
 * confirmed READ — a fail-open seed for the future read-recognition gate.
 *
 * {@link instrumentEffectsByPath} replaces that scattered, leak-prone approach
 * with ONE wrapper applied at each hostApi construction boundary
 * (`createHostApi`, `createPluginStorage`). It recursively wraps every
 * function-valued leaf so EVERY method invocation auto-records its effect —
 * looked up by method PATH in {@link HOSTAPI_EFFECT_BY_PATH} — BEFORE delegating
 * to the real implementation. Two guarantees end the whack-a-mole:
 *
 *  1. FAIL-CLOSED default — a method PATH absent from the SOT records
 *     `unclassifiedHostApiMethod` (effect `write`) + a one-time dev warning, so a
 *     future-added method is conservatively mutating and can NEVER be a silent
 *     fail-open read.
 *  2. The completeness test (`__tests__/hostapi-effect-completeness.test.ts`)
 *     asserts every real hostApi leaf is mapped, mechanically forcing coverage.
 *
 * PURE side-effect: the wrapper records and then delegates with EXACT behavior —
 * same arguments, `this`-binding, return value (sync/Promise), and error
 * propagation. Recording is wrapped in try/catch so it can never alter the
 * hostApi's observable behavior. Lookup is an O(1) object access on the hot path.
 */
import { createLogger } from "../lib/logger.js";
import { HOSTAPI_EFFECT_BY_PATH, type StaticChokepointKind } from "./effect-kind.js";
import { recordChokepoint, recordEffect } from "./effect-ledger.js";

const log = createLogger("hostapi-effect-recorder");

/** Marks an already-instrumented object so a nested re-wrap is a no-op. */
const INSTRUMENTED = Symbol("lvis.hostApiEffectInstrumented");

/** One-time-per-path guard for the unmapped-method dev warning. */
const warnedUnmappedPaths = new Set<string>();

/**
 * Record the host-observed effect for one hostApi method PATH against the
 * ambient ledger. Looks the path up in the classification SOT; an unmapped path
 * is recorded fail-closed as a mutating `unclassifiedHostApiMethod` with a
 * one-time dev warning naming the method. A no-op outside an invocation scope.
 */
function recordEffectForPath(path: string, args: readonly unknown[]): void {
  const spec = HOSTAPI_EFFECT_BY_PATH[path];
  if (!spec) {
    if (!warnedUnmappedPaths.has(path)) {
      warnedUnmappedPaths.add(path);
      log.warn(
        "unmapped hostApi method '%s' — recorded fail-closed as mutating; add it to HOSTAPI_EFFECT_BY_PATH (effect-kind.ts)",
        path,
      );
    }
    recordChokepoint("unclassifiedHostApiMethod", path);
    return;
  }
  const target = spec.targetFromArgs?.(args);
  if (spec.effectFromArgs) {
    // Verb-derived effect (hostFetch) — class is not static.
    recordEffect({ kind: spec.kind, effect: spec.effectFromArgs(args), ...(target !== undefined ? { target } : {}) });
    return;
  }
  // Static class — sourced from the CHOKEPOINT_EFFECT SOT via recordChokepoint.
  recordChokepoint(spec.kind as StaticChokepointKind, target);
}

/** Recurse only into plain namespace objects (e.g. storage/config/agentApproval). */
function isPlainNamespace(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Wrap `target` so every function-valued leaf auto-records its effect (by method
 * PATH) before delegating. Idempotent — an already-instrumented object (or
 * nested namespace) is returned unchanged so applying the wrapper at multiple
 * construction boundaries never double-records.
 *
 * @param target  the hostApi object (or a nested namespace).
 * @param prefix  dotted path prefix for nested namespaces (e.g. `"storage"`).
 */
export function instrumentEffectsByPath<T extends object>(target: T, prefix = ""): T {
  if ((target as Record<symbol, unknown>)[INSTRUMENTED]) return target;

  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "function") {
      const original = value as (...callArgs: unknown[]) => unknown;
      wrapped[key] = function instrumented(this: unknown, ...callArgs: unknown[]): unknown {
        // Recording is a PURE side-effect — it must never alter hostApi
        // behavior, so any failure here (bad arg shape, URL parse) is swallowed.
        try {
          recordEffectForPath(path, callArgs);
        } catch {
          /* recording must not break the host */
        }
        // Delegate with the ORIGINAL namespace as `this` so methods that read
        // `this` keep working; preserves args / return value / async / throw.
        return Reflect.apply(original, target, callArgs);
      };
    } else if (isPlainNamespace(value)) {
      wrapped[key] = instrumentEffectsByPath(value, path);
    } else {
      wrapped[key] = value;
    }
  }
  Object.defineProperty(wrapped, INSTRUMENTED, { value: true, enumerable: false });
  return wrapped as T;
}
