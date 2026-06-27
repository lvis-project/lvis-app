/**
 * Effect-boundary ENFORCEMENT — the enforcement stage of the host-classify
 * completion design.
 *
 * The observability stage (the merged effect recorder, {@link
 * instrumentEffectsByPath}) RECORDS every host-mediated effect against a
 * per-invocation ledger as a PURE side-effect. This module adds a SEPARATE,
 * FLAG-GATED enforcement layer at the SAME chokepoint surface: when the host-owned
 * `hostClassifiesRisk` flag is ON and a plugin tool reaches a MUTATING
 * host-mediated effect, the user is asked to approve AT THE EFFECT (before the
 * mutation executes); a denial throws so the plugin handler surfaces a tool error;
 * reads never prompt.
 *
 * ── Three hard guarantees (the recorder's cluster review was brutal about
 *    fail-open / behaviour-change) ──────────────────────────────────────────────
 *
 *  1. FLAG OFF = ZERO behaviour change. When {@link EffectEnforcementDeps.flagEnabled}
 *     returns false (the default), the wrapped method is a DIRECT pass-through:
 *     a single boolean read then `Reflect.apply(original, …)` — no gate, no SOT
 *     lookup, no extra `await`, the identical return value / args / `this` / throw.
 *
 *  2. SOT-DERIVED, FAIL-CLOSED, ASYNC-ONLY gating. The gated set
 *     ({@link GATED_EFFECT_PATHS}) is NOT hand-curated — it is derived MECHANICALLY
 *     from the SOT as { write-classified ASYNC paths } minus the explicit,
 *     documented {@link ENFORCEMENT_EXCLUSIONS}. A future async WRITE chokepoint
 *     added to the SOT (and forced into the recorder by its completeness test) is
 *     therefore AUTOMATICALLY gated here too — it can never be RECORDED as a write
 *     yet silently ship UN-enforced. The enforcement completeness test asserts the
 *     gated set and the exclusions PARTITION every write-classified path, so a new
 *     write MUST be consciously gated or excluded (fail-closed). Awaiting a modal
 *     is async, so a SYNCHRONOUS mutating chokepoint (the lone one is
 *     `registerKeywords`) is NEVER converted to async (a contract break) — it is an
 *     explicit exclusion, still WRITE-classified; under the pre-exec relaxation flag
 *     it therefore runs UNGATED, but is BOUNDED (start-only, unreachable during
 *     tool.execute — see {@link ENFORCEMENT_EXCLUSIONS}). hostFetch is the lone
 *     VERB-derived chokepoint: its read/write class
 *     depends on a plugin-controlled arg VALUE, so it is gated INLINE in its host
 *     closure from the SAME single verb snapshot that pins the wire (never re-read
 *     here), via {@link gateMutatingEffect} directly — an explicit exclusion of the
 *     generic wrapper.
 *
 *  3. HEADLESS = NO modal, EVALUATED BEFORE ANY GRANT. In a headless/routine
 *     invocation (no interactive approver) the gate must NOT call `requestAndWait`.
 *     It fails CLOSED (throws), never silently allows — and the headless check runs
 *     BEFORE the remembered-grant short-circuit, so a grant blessed in the
 *     FOREGROUND can never auto-allow the same descriptor in a later UNATTENDED
 *     headless run. Headless mutations are already gated by the host's headless
 *     lane; the effect-gate engages interactively only in the FOREGROUND.
 *
 * ── Composition ────────────────────────────────────────────────────────────────
 * Enforcement is applied as the OUTER layer over the recorder
 * (`enforceMutatingEffects(instrumentEffectsByPath(raw))`), NOT inner, for two
 * reasons: (a) the pure recorder stays byte-for-byte untouched and its idempotence
 * symbol is never disturbed (the cluster-reviewed wrapper is a hard "do not
 * modify"); (b) a DENIED effect is therefore never recorded as a host-observed
 * mutation — the recorder only sees effects that actually proceed to the real impl,
 * so a denied write produces no phantom row in the shadow dataset. Per gated call
 * the order is gate → record → real impl. (hostFetch self-records before its inline
 * gate, matching its documented "record the attempted effect even on a denied
 * egress" behaviour.)
 *
 * ── Security ───────────────────────────────────────────────────────────────────
 * The gate decision derives ONLY from host-owned signals — the SOT effect class
 * ({@link CHOKEPOINT_EFFECT}) and the recorder's non-secret forensic descriptor —
 * NEVER from a plugin-forgeable category/name/description. The effect (read vs
 * write) is decided from the SOT BEFORE any plugin-arg extraction, so a hostile or
 * stateful arg getter that throws can never flip the write or suppress the gate
 * (mirrors the recorder's suppression-resistance fix). On deny the real impl is
 * never invoked. The confused-deputy nonce+HMAC defence is inherited for free by
 * routing through {@link ApprovalGate.requestAndWait}.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalGate, ApprovalChoice } from "./approval-gate.js";
import {
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
  writeClassifiedPaths,
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";
import { isPlainNamespace, INSTRUMENTED } from "./hostapi-effect-recorder.js";

/**
 * EXPLICIT, DOCUMENTED enforcement exclusions — paths that the SOT classifies as
 * WRITE but that are DELIBERATELY not gated by the generic enforcement wrapper,
 * each with a one-line reason. A path is here for exactly one of two structural
 * reasons: it is SYNCHRONOUS (an await-based gate would break its contract), or it
 * is gated elsewhere / by a different mechanism.
 *
 * Interaction with the pre-exec relaxation (the HONEST residual — NOT papered
 * over): the relaxation stage skips the pre-exec ask for ALL foreground
 * first-party plugin tools — it does NOT pre-classify read vs write (see
 * executor.ts: the relaxation flips ANY foreground/plugin/layer≥3 `ask` to
 * `allow`). So it is FALSE that an excluded write "keeps its pre-exec ask because
 * the tool is write-classified": under the flag the pre-exec ask is gone for every
 * relaxed plugin tool, and the ONLY remaining gate is the effect-boundary.
 * Therefore the write-classified paths split into:
 *   • GATED ({@link GATED_EFFECT_PATHS}, now incl. `openExternalUrl`) — caught at
 *     the effect-gate (deny → blocked). `hostFetch` self-gates INLINE in its host
 *     closure (a different mechanism, the SAME effect-gate). These are NOT ungated.
 *   • The THREE remaining exclusions run UNGATED under the flag, each BOUNDED:
 *       – `registerKeywords` — SYNC; start-only (createPlugin/start), never reached
 *         during a gated tool.execute, so it produces NO effect mid-invocation.
 *       – `config.set` — mutates the plugin's OWN config namespace (not
 *         user/external data) + a guarded reload; bounded blast radius.
 *       – `agentApproval.respond` — resolves HOST-OWNED approval machinery; gating
 *         it with the same machinery is circular (would deadlock).
 * That bounded-ungated set is the honest residual, enumerated here + in
 * executor.ts — it is NOT a hidden fail-open hole (each item states why it is
 * bounded). `openExternalUrl` (system-browser egress / exfil-class) was MOVED OUT
 * of this set into the effect-gate precisely because it had genuine exposure.
 */
export const ENFORCEMENT_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  // SYNCHRONOUS registry mutation (returns void) — an await-based modal is a
  // contract break, so it is never gated here. Under the relaxation flag it runs
  // UNGATED, but is BOUNDED: in every 1st-party plugin it is called only during
  // plugin start()/activation (createPlugin/start), OUTSIDE any
  // runWithEffectGateContext scope, so it produces NO effect during a gated
  // tool.execute invocation — it is not reachable mid-execute.
  ["registerKeywords", "SYNC registry mutation — cannot await a modal; start-only (createPlugin/start), not reachable during tool.execute → bounded ungated under the flag"],
  // Mutates the plugin's OWN config namespace + already triggers a guarded
  // reload. Under the relaxation flag it runs UNGATED, but is BOUNDED to the
  // plugin's own config (not user/external data).
  ["config.set", "own-config namespace mutation (not user/external data) + guarded reload → bounded ungated under the flag"],
  // RESOLVES a pending approval — gating the approval machinery with itself is
  // circular (would deadlock). Under the relaxation flag it runs UNGATED, BOUNDED
  // by being confined to resolving HOST-OWNED approval state.
  ["agentApproval.respond", "resolves host-owned approval machinery (gating it with itself is circular/deadlock) → bounded ungated under the flag"],
  // The lone VERB-derived egress — gated INLINE in its host closure from the
  // single verb snapshot that also self-records + pins the wire (so the gate's
  // read/write class can never diverge from what is sent). NOT ungated: it is
  // caught at the SAME effect-gate, just inline. The generic wrapper skips it
  // precisely because it self-gates.
  ["hostFetch", "verb-derived egress — self-gated INLINE in its closure (same effect-gate, not ungated); the generic wrapper skips it"],
]);

/**
 * The effect-gated method PATHs — MECHANICALLY derived from the SOT, NOT a
 * hand-curated list, so the set is FAIL-CLOSED: a future async WRITE chokepoint
 * added to {@link HOSTAPI_EFFECT_BY_PATH} (and forced into the recorder by its
 * completeness test) is AUTOMATICALLY gated here too — it can never be RECORDED as
 * a write yet silently ship UN-enforced (the exact "manual enumeration leaks"
 * defect the recorder spent rounds eliminating). The derivation is:
 *
 *     GATED_EFFECT_PATHS = { p ∈ writeClassifiedPaths()
 *                            | p ∉ ENFORCEMENT_EXCLUSIONS ∧ HOSTAPI_EFFECT_BY_PATH[p].async }
 *
 * i.e. every WRITE-classified path that is ALREADY async and is NOT an explicit
 * exclusion. The await-based wrapper can only gate an already-async method, so the
 * `async` filter is load-bearing — a write-classified path that is neither async
 * nor excluded (a sync write) is NOT silently dropped: it falls into NEITHER
 * GATED_EFFECT_PATHS nor ENFORCEMENT_EXCLUSIONS, which the enforcement completeness
 * test REJECTS (it asserts the two sets PARTITION writeClassifiedPaths()). That
 * inverts the default to fail-closed: a new write chokepoint MUST be consciously
 * gated (async) or excluded; it can never silently ship ungated.
 *
 * The wrapper additionally re-derives the effect from the SOT per call and only
 * gates a `write`, so a future SOT drift reclassifying a member to `read` fails
 * SAFE (pass-through, never a spurious read prompt).
 */
export const GATED_EFFECT_PATHS: ReadonlySet<string> = (() => {
  const gated = new Set<string>();
  for (const path of writeClassifiedPaths()) {
    if (ENFORCEMENT_EXCLUSIONS.has(path)) continue;
    // Only an ALREADY-async method can be gated by the await-based wrapper. A
    // write-classified, non-excluded, NON-async path is a design gap the
    // completeness test rejects — it is left out of the gated set here (it is
    // also absent from the exclusions), so the partition assertion fails CI.
    if (HOSTAPI_EFFECT_BY_PATH[path]?.async) gated.add(path);
  }
  return gated;
})();

/**
 * Per-invocation enforcement context, bound by the executor around `tool.execute`
 * (next to the effect ledger) and read by the effect-gate through
 * {@link AsyncLocalStorage}. Carries the host-owned FOREGROUND/headless signal
 * (the same `permissionContext.headless` that drives the host's headless lane), the
 * tool name for the modal, and an invocation-scoped `allow-once` grant set so N
 * writes to the same target inside ONE tool call pop at most one modal.
 */
export interface EffectGateContext {
  /** True iff this invocation runs in a headless/routine lane (no interactive approver). */
  readonly headless: boolean;
  /** The executing tool's name — surfaced in the approval modal. */
  readonly toolName: string;
  /** Invocation-scoped `allow-once` descriptor keys (discarded when the frame pops). */
  readonly onceGrants: Set<string>;
}

const gateContextStorage = new AsyncLocalStorage<EffectGateContext>();

/**
 * Run `fn` with an effect-gate context bound for the async chain of one tool
 * invocation. A fresh `allow-once` grant set is minted per call so once-grants
 * never leak across invocations. AsyncLocalStorage propagates through the loopback
 * transport (the same path the effect ledger relies on), so the per-plugin hostApi
 * closures see this context when they reach a gated effect.
 */
export function runWithEffectGateContext<T>(
  context: Omit<EffectGateContext, "onceGrants">,
  fn: () => Promise<T>,
): Promise<T> {
  return gateContextStorage.run({ ...context, onceGrants: new Set<string>() }, fn);
}

/** Read the ambient effect-gate context, or `undefined` outside a gated invocation. */
export function currentEffectGateContext(): EffectGateContext | undefined {
  return gateContextStorage.getStore();
}

/**
 * Process-lifetime grant memory keyed by the (pluginId, methodPath, target)
 * descriptor. `allow-session` / `allow-always` suppress repeat modals for the same
 * effect descriptor; `deny-always` short-circuits to a throw without re-prompting.
 * `allow-once` lives in the per-invocation {@link EffectGateContext.onceGrants}
 * instead, not here. The key is the host-owned descriptor only — a grant is NEVER
 * widened beyond its exact (plugin, method, target) descriptor.
 *
 * NOTE (current scope): `allow-always` is held for the process lifetime here;
 * durable cross-restart persistence of effect grants is left to the later stage
 * that also surfaces the flag flip for a user security decision. No behaviour
 * depends on persistence while the flag ships OFF by default.
 */
const descriptorGrants = new Map<string, ApprovalChoice>();

/**
 * Stable, non-widening grant key for one effect descriptor. The three components
 * are JSON-encoded as a tuple so each is unambiguously escaped — a pluginId,
 * methodPath, or target that itself contains the delimiter (or a quote) can never
 * collide two distinct descriptors onto one key (which would widen a grant). A
 * missing target is encoded as `null`, distinct from an empty-string target.
 */
function descriptorKey(pluginId: string, methodPath: string, target: string | undefined): string {
  return JSON.stringify([pluginId, methodPath, target ?? null]);
}

/** Thrown by the effect-gate when a mutating effect is denied; surfaced as a tool error. */
export class EffectBoundaryDeniedError extends Error {
  readonly pluginId: string;
  readonly methodPath: string;
  readonly target: string | undefined;
  readonly reason: "denied" | "headless";
  constructor(pluginId: string, methodPath: string, target: string | undefined, reason: "denied" | "headless") {
    const where = target ? `${methodPath} → ${target}` : methodPath;
    const detail =
      reason === "headless"
        ? "no interactive approver in a headless/routine context"
        : "the user denied the effect approval";
    super(`[effect-gate] plugin '${pluginId}' blocked from ${where}: ${detail}`);
    this.name = "EffectBoundaryDeniedError";
    this.pluginId = pluginId;
    this.methodPath = methodPath;
    this.target = target;
    this.reason = reason;
  }
}

/** Dependencies the effect-gate needs at a chokepoint. */
export interface EffectEnforcementDeps {
  /** The calling plugin's id, bound at hostApi construction (never plugin-supplied at call time). */
  readonly pluginId: string;
  /** The main-process approval gate used to ask + await the user decision. */
  readonly approvalGate: ApprovalGate;
  /** Live `hostClassifiesRisk` flag read — evaluated PER CALL so a Settings toggle is honoured. */
  readonly flagEnabled: () => boolean;
}

/**
 * The effect-boundary gate for a single host-classified WRITE. Returns normally to
 * let the mutation proceed; throws {@link EffectBoundaryDeniedError} to block it.
 *
 * Short-circuits (in order):
 *   1. flag OFF                 → return (pass-through; zero change).
 *   2. effect !== "write"       → return (reads never prompt).
 *   3. no gate context bound    → return (a boot-time / out-of-invocation hostApi
 *                                 call is not a plugin-tool effect — nothing to gate).
 *   4. headless                 → throw (fail-closed; a modal is impossible). This is
 *                                 evaluated BEFORE any grant short-circuit so a grant
 *                                 blessed in the FOREGROUND can NEVER auto-allow the
 *                                 same descriptor in a later UNATTENDED headless run
 *                                 (headless never honours a foreground-obtained grant).
 *   5. existing grant           → honour the remembered decision (allow → return;
 *                                 deny-always → throw) without a modal. FOREGROUND only.
 *   6. foreground               → await `requestAndWait`; record the grant; allow or throw.
 */
export async function gateMutatingEffect(params: {
  pluginId: string;
  methodPath: string;
  effect: Effect;
  target: string | undefined;
  approvalGate: ApprovalGate;
  flagEnabled: () => boolean;
}): Promise<void> {
  if (!params.flagEnabled()) return; // FLAG OFF — pass-through (byte-for-byte today)
  if (params.effect !== "write") return; // reads never prompt

  const ctx = currentEffectGateContext();
  // Outside a gated tool invocation (boot, plugin lifecycle) there is no tool
  // effect to gate and no approver — the pre-exec ask governs only tool invocations.
  if (!ctx) return;

  // Headless lane: a modal is impossible — fail CLOSED (never silently allow).
  // EVALUATED BEFORE the grant short-circuits below: a grant (allow-session /
  // allow-always) obtained while the user WATCHED in the foreground must NOT
  // later auto-allow the same descriptor in an unattended headless/routine run
  // (CLAUDE.md: "Headless/routine 실행은 allow rule/auto mode 로 write/shell/network 를
  // 우회하지 않는다"). In a headless context the gate ALWAYS throws, regardless of any
  // prior foreground grant. Headless mutations remain gated by the pre-exec
  // headless lane.
  if (ctx.headless) {
    throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "headless");
  }

  const key = descriptorKey(params.pluginId, params.methodPath, params.target);

  // Honour a prior explicit FOREGROUND decision for this exact descriptor (dedup).
  if (ctx.onceGrants.has(key)) return;
  const remembered = descriptorGrants.get(key);
  if (remembered) {
    if (remembered === "deny-always") {
      throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "denied");
    }
    return; // allow-session / allow-always
  }

  // Foreground: ask at the effect boundary and await the user decision. The gate
  // mints + verifies its own nonce+HMAC (confused-deputy defence) internally.
  const where = params.target ? `${params.methodPath} → ${params.target}` : params.methodPath;
  const decision = await params.approvalGate.requestAndWait({
    id: randomUUID(),
    category: "agent-action",
    kind: "agent-action",
    toolName: ctx.toolName,
    // `meta` keeps the sandbox-capability row out of this non-execution modal.
    toolCategory: "meta",
    // NON-SECRET descriptor only (host-owned effect class + forensic target).
    // When there is NO target the grant is METHOD-WIDE (any call to this method,
    // e.g. callLlm / spawnWorker, that is allow-always'd). The `methodWide`
    // breadth marker surfaces that to the renderer so the later effect-modal card
    // can show "this allows the method for ALL targets" (target-scoped requests
    // omit it). The marker carries no secret.
    args: {
      effect: params.effect,
      methodPath: params.methodPath,
      ...(params.target !== undefined ? { target: params.target } : { methodWide: true }),
    },
    reason: `Plugin "${params.pluginId}" is about to perform a host-mediated ${params.effect}: ${where}`,
    source: "plugin",
    sourcePluginId: params.pluginId,
    approvalScope: params.methodPath,
    trustOrigin: "plugin-emitted",
    createdAt: Date.now(),
  });

  switch (decision.choice) {
    case "allow-once":
      ctx.onceGrants.add(key);
      return;
    case "allow-session":
      descriptorGrants.set(key, "allow-session");
      return;
    case "allow-always":
      descriptorGrants.set(key, "allow-always");
      return;
    case "deny-always":
      descriptorGrants.set(key, "deny-always");
      throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "denied");
    default: // deny-once
      throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "denied");
  }
}

/** Marks an already-enforced object so a nested re-wrap is a no-op (idempotent). */
const ENFORCED = Symbol("lvis.hostApiEffectEnforced");

/**
 * Wrap `target` so every gated async-write leaf (see {@link GATED_EFFECT_PATHS})
 * awaits {@link gateMutatingEffect} before delegating, while EVERY other leaf —
 * reads, sync methods, hostFetch, nested namespaces' non-gated methods — passes
 * through byte-for-byte. Apply as the OUTER layer over the recorder
 * (`enforceMutatingEffects(instrumentEffectsByPath(raw), deps)`); recursion mirrors
 * the recorder's traversal (own-enumerable keys, plain namespaces only) so the two
 * layers agree on the surface they cover.
 *
 * Idempotent two ways: (a) via {@link ENFORCED}, an already-enforced object is
 * returned untouched; (b) the recorder's non-enumerable {@link INSTRUMENTED}
 * symbol is PROPAGATED onto the fresh enforced wrapper, so the enforced output is
 * STILL recognised as instrumented and a later `instrumentEffectsByPath` over it
 * is a no-op (no double-wrap / double-record). Without this, the enforced object —
 * a fresh literal — would drop the recorder's idempotence symbol.
 *
 * @param target the (already recorder-instrumented) hostApi object or a namespace.
 * @param deps   pluginId + approvalGate + the live flag read.
 * @param prefix dotted path prefix for nested namespaces (e.g. `"storage"`).
 */
export function enforceMutatingEffects<T extends object>(
  target: T,
  deps: EffectEnforcementDeps,
  prefix = "",
): T {
  if ((target as Record<symbol, unknown>)[ENFORCED]) return target;

  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "function" && GATED_EFFECT_PATHS.has(path)) {
      const original = value as (...callArgs: unknown[]) => unknown;
      wrapped[key] = function enforced(this: unknown, ...callArgs: unknown[]): unknown {
        // FLAG OFF — DIRECT pass-through: one boolean read then the identical
        // delegation. No gate, no SOT lookup, no extra await; the return value,
        // args, `this`, and throw are byte-for-byte today's behaviour.
        if (!deps.flagEnabled()) {
          return Reflect.apply(original, target, callArgs);
        }
        // FLAG ON — gate (async) then delegate. Every gated path is already async,
        // so returning a Promise here preserves the method contract.
        return (async (): Promise<unknown> => {
          // Decide the effect from the host-owned SOT BEFORE touching any
          // plugin-controlled arg, so a throwing/stateful arg getter can never
          // flip the write or suppress the gate (mirrors the recorder's fix).
          const spec = HOSTAPI_EFFECT_BY_PATH[path];
          const effect: Effect = spec
            ? CHOKEPOINT_EFFECT[spec.kind as StaticChokepointKind] ?? "write"
            : "write";
          // SNAPSHOT the forensic target to a primitive EXACTLY ONCE here (same
          // TOCTOU class as the hostFetch verb fix). Object-field targets
          // (triggerConversation.source, agentApproval.request.scope, openAuth*
          // opts.url) are re-readable plugin getters; `targetFromArgs` invokes the
          // getter a SINGLE time and the resulting `targetSnapshot` STRING is the
          // sole value passed to the gate, so the descriptor SHOWN in the modal and
          // the (pluginId, methodPath, target) GRANT KEY are pinned to ONE read and
          // can never diverge from each other. (The real impl re-reads its own args
          // independently, but the host-owned SOT already fixed the effect to
          // `write` above, so a stateful getter can NOT flip write→read; the only
          // residual is the forensic descriptor string, which this snapshot pins.)
          // Best-effort + NON-SECRET, read AFTER the effect is fixed: a throwing
          // getter costs only the descriptor, never the gate.
          let targetSnapshot: string | undefined;
          try {
            targetSnapshot = spec?.targetFromArgs?.(callArgs);
          } catch {
            /* best-effort target — the gate still fires on the SOT write */
          }
          await gateMutatingEffect({
            pluginId: deps.pluginId,
            methodPath: path,
            effect,
            target: targetSnapshot,
            approvalGate: deps.approvalGate,
            flagEnabled: deps.flagEnabled,
          });
          return Reflect.apply(original, target, callArgs);
        })();
      };
    } else if (typeof value === "function") {
      // Reads, sync methods, and the verb-derived hostFetch pass through unchanged
      // (hostFetch is gated INLINE in its closure; sync methods cannot await).
      wrapped[key] = value;
    } else if (isPlainNamespace(value)) {
      wrapped[key] = enforceMutatingEffects(value, deps, path);
    } else {
      wrapped[key] = value;
    }
  }
  Object.defineProperty(wrapped, ENFORCED, { value: true, enumerable: false });
  // PROPAGATE the recorder's idempotence symbol onto the fresh enforced object so
  // an enforced (and thus already-recorder-instrumented) object is still seen as
  // INSTRUMENTED — a later `instrumentEffectsByPath` over it stays a no-op and
  // can never double-wrap/double-record. Mirrors the recorder stamping it on its
  // own wrapper; copied per-level so nested namespaces keep the guard too.
  if ((target as Record<symbol, unknown>)[INSTRUMENTED]) {
    Object.defineProperty(wrapped, INSTRUMENTED, { value: true, enumerable: false });
  }
  return wrapped as T;
}

/** @internal Test only — clears the process-lifetime descriptor grant memory. */
export function __resetEffectGrantsForTest(): void {
  descriptorGrants.clear();
}
