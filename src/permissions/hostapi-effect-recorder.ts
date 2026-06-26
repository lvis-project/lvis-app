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
import {
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";
import { recordChokepoint, recordEffect, type EffectEntry } from "./effect-ledger.js";

const log = createLogger("hostapi-effect-recorder");

/** Marks an already-instrumented object so a nested re-wrap is a no-op. */
const INSTRUMENTED = Symbol("lvis.hostApiEffectInstrumented");

/** One-time-per-path guard for the unmapped-method dev warning. */
const warnedUnmappedPaths = new Set<string>();

/** One-time-per-path guard for the un-instrumented non-plain-namespace warning. */
const warnedNonPlainNamespaces = new Set<string>();

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
    // `path` is the host-derived method name (not a plugin-controlled arg), so a
    // hostile plugin cannot use it to suppress this fail-closed mutating record.
    recordChokepoint("unclassifiedHostApiMethod", path);
    return;
  }

  // SECURITY — fail-CLOSED effect, decided + recorded BEFORE any plugin-arg
  // extraction. The read/write CLASS comes from the host-owned SOT, never from a
  // plugin-controlled arg getter: a malicious 1st-party plugin could pass a
  // stateful getter that THROWS on the recorder's read but returns a usable
  // value on the real operation's later read. If effect classification depended
  // on that getter, the throw would drop the whole record and the executed
  // mutation would surface as a confirmed READ — the exact fail-open seed this
  // model exists to remove. Static chokepoints take their class from
  // CHOKEPOINT_EFFECT (no args). The only verb-derived chokepoint (hostFetch)
  // MUST read the HTTP method from args; if that read/normalize throws we fail
  // CLOSED to "write" so a throw can never drop the effect or downgrade a write
  // to a read.
  let effect: Effect;
  if (spec.effectFromArgs) {
    try {
      effect = spec.effectFromArgs(args);
    } catch {
      effect = "write";
    }
  } else {
    effect = CHOKEPOINT_EFFECT[spec.kind as StaticChokepointKind];
  }
  // Commit the {kind, effect} to the ledger NOW (the ledger holds `entry` by
  // reference), so `hasMutatingEffect` is locked in before any forensic-target
  // getter — which touches plugin-controlled args — can run.
  const entry: EffectEntry = { kind: spec.kind, effect };
  recordEffect(entry);

  // The forensic `target` is an OPTIONAL, NON-SECRET descriptor (origin / key
  // name / scope-source string) read from plugin-controlled args. It runs in a
  // LOCAL try/catch AFTER the effect is recorded: a throwing/hostile getter
  // costs only the descriptor and can NEVER suppress or alter the already-
  // recorded effect. It must never start capturing secret VALUES.
  try {
    const target = spec.targetFromArgs?.(args);
    if (target !== undefined) entry.target = target;
  } catch {
    /* target is best-effort — the mutating effect is already on the ledger */
  }
}

/**
 * Recurse only into plain namespace objects (e.g. storage/config/agentApproval).
 * Exported so the completeness test asserts the SAME traversal surface the
 * wrapper instruments — a hostApi namespace that is NOT plain (class instance /
 * custom prototype) would otherwise pass completeness yet be copied verbatim and
 * left UNINSTRUMENTED by the wrapper (a silent fail-open one level up).
 */
export function isPlainNamespace(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True if `value` carries any function-valued leaf, scanning the SAME traversal
 * surface the wrapper and completeness test use (own-enumerable keys of
 * non-array objects). Used to warn when a NON-plain namespace that holds
 * method(s) is copied through un-instrumented.
 */
function hasFunctionLeaf(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((key) =>
    hasFunctionLeaf((value as Record<string, unknown>)[key]),
  );
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
        // ASSUMPTION: hostApi methods do not self-delegate. A method that called
        // a sibling via `this.sibling()` would reach the ORIGINAL (un-wrapped)
        // sibling — `this === target`, not `wrapped` — bypassing the wrapper, so
        // the sibling's effect would NOT be recorded. No hostApi method
        // self-delegates today; if one ever does it must record explicitly (or
        // be split so each leaf is invoked directly through the wrapper).
        return Reflect.apply(original, target, callArgs);
      };
    } else if (isPlainNamespace(value)) {
      wrapped[key] = instrumentEffectsByPath(value, path);
    } else {
      // Non-function value that is NOT a plain namespace (class instance /
      // custom prototype / array). The wrapper only INSTRUMENTS plain
      // namespaces, so this is copied through verbatim — but if it carries
      // function leaves they are left UNINSTRUMENTED (a silent fail-open one
      // level up). We cannot safely wrap arbitrary prototype methods without
      // risking behavior changes, so we emit a one-time fail-closed WARN and
      // rely on the completeness test (which shares the SAME isPlainNamespace
      // predicate) to REJECT such a namespace in CI — it must be made a plain
      // object or instrumented explicitly.
      if (hasFunctionLeaf(value) && !warnedNonPlainNamespaces.has(path)) {
        warnedNonPlainNamespaces.add(path);
        log.warn(
          "hostApi value '%s' is a non-plain object carrying method(s) — those methods are NOT effect-instrumented (fail-open); make it a plain-object namespace or instrument it explicitly (the completeness test will reject it)",
          path,
        );
      }
      wrapped[key] = value;
    }
  }
  Object.defineProperty(wrapped, INSTRUMENTED, { value: true, enumerable: false });
  return wrapped as T;
}
