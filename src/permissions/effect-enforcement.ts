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
 *  2. ASYNC-ONLY gating. Awaiting a user modal is async, so ONLY chokepoints that
 *     are ALREADY async ({@link GATED_ASYNC_WRITE_PATHS}) are gated here. A
 *     SYNCHRONOUS mutating chokepoint is NEVER converted to async (a contract
 *     break) — it stays covered by the pre-exec tool-level ask. hostFetch is the
 *     lone VERB-derived chokepoint: its read/write class depends on a
 *     plugin-controlled arg VALUE, so it is gated INLINE in its host closure from
 *     the SAME single verb snapshot that pins the wire (never re-read here), via
 *     {@link gateMutatingEffect} directly — the generic wrapper skips it.
 *
 *  3. HEADLESS = NO modal. In a headless/routine invocation (no interactive
 *     approver) the gate must NOT call `requestAndWait`. It fails CLOSED (throws),
 *     never silently allows. Headless mutations are already gated by the host's
 *     headless lane; the effect-gate engages interactively only in the FOREGROUND.
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
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";
import { isPlainNamespace } from "./hostapi-effect-recorder.js";

/**
 * The host-mediated mutating chokepoint method PATHs that are ALREADY async and
 * are therefore gated by the generic enforcement wrapper. Curated to the
 * cross-boundary egress / persistence / auth-session / worker / overlay mutations.
 * Membership rationale per chokepoint:
 *
 *   ── Gated here (async writes) ──
 *   storage.write / storage.writeJson / storage.rm / storage.mkdir
 *                              — plugin persistence mutations (Promise-returning).
 *   openAuthWindow             — persists auth cookies/session.
 *   openAuthPartitionViewer    — refreshes/persists partition cookies (silent SSO).
 *   clearAuthPartition         — destructively wipes a session partition.
 *   callLlm                    — body-bearing external LLM egress.
 *   spawnWorker                — spawns a host-mediated worker process.
 *   triggerConversation        — stages an overlay prompt into the host UI.
 *   agentApproval.request      — registers an issuer + creates a pending gate entry.
 *
 *   ── NOT gated here (covered by the pre-exec tool-level ask) ──
 *   hostFetch                  — async, but VERB-derived: gated INLINE in its host
 *                                closure from the single verb snapshot (see file
 *                                header) so the gate's read/write class can never
 *                                diverge from the wire. The generic wrapper skips it.
 *   registerKeywords           — SYNCHRONOUS registry mutation (returns void);
 *                                cannot await a modal without a contract break.
 *   config.set                 — async, but mutates the plugin's OWN config
 *                                namespace and already triggers a guarded reload;
 *                                left to the pre-exec ask to keep this layer's
 *                                surface to the cross-boundary mutations.
 *   openExternalUrl            — async, but already routed + audited through the
 *                                host link policy; left to the pre-exec ask.
 *   agentApproval.respond      — async, but it RESOLVES a pending approval; gating
 *                                the approval machinery with itself is circular.
 *
 * Every gated path is verified async by construction (see PluginHostApi); the
 * wrapper additionally derives the effect from the SOT and only gates a `write`,
 * so a future SOT drift that reclassified one of these to `read` fails SAFE
 * (pass-through, never a spurious read prompt).
 */
export const GATED_ASYNC_WRITE_PATHS: ReadonlySet<string> = new Set([
  "storage.write",
  "storage.writeJson",
  "storage.rm",
  "storage.mkdir",
  "openAuthWindow",
  "openAuthPartitionViewer",
  "clearAuthPartition",
  "callLlm",
  "spawnWorker",
  "triggerConversation",
  "agentApproval.request",
]);

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

/** Stable, non-widening grant key for one effect descriptor. */
function descriptorKey(pluginId: string, methodPath: string, target: string | undefined): string {
  return `${pluginId} ${methodPath} ${target ?? ""}`;
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
 *   4. existing grant           → honour the remembered decision (allow → return;
 *                                 deny-always → throw) without a modal.
 *   5. headless                 → throw (fail-closed; a modal is impossible).
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

  const key = descriptorKey(params.pluginId, params.methodPath, params.target);

  // Honour a prior explicit decision for this exact descriptor (dedup) — this is a
  // remembered user choice, not a silent allow, so it is honoured even headless.
  if (ctx.onceGrants.has(key)) return;
  const remembered = descriptorGrants.get(key);
  if (remembered) {
    if (remembered === "deny-always") {
      throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "denied");
    }
    return; // allow-session / allow-always
  }

  // Headless lane: a modal is impossible — fail CLOSED (never silently allow).
  if (ctx.headless) {
    throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "headless");
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
    args: {
      effect: params.effect,
      methodPath: params.methodPath,
      ...(params.target !== undefined ? { target: params.target } : {}),
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
 * Wrap `target` so every gated async-write leaf (see {@link GATED_ASYNC_WRITE_PATHS})
 * awaits {@link gateMutatingEffect} before delegating, while EVERY other leaf —
 * reads, sync methods, hostFetch, nested namespaces' non-gated methods — passes
 * through byte-for-byte. Apply as the OUTER layer over the recorder
 * (`enforceMutatingEffects(instrumentEffectsByPath(raw), deps)`); recursion mirrors
 * the recorder's traversal (own-enumerable keys, plain namespaces only) so the two
 * layers agree on the surface they cover. Idempotent via {@link ENFORCED}.
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

    if (typeof value === "function" && GATED_ASYNC_WRITE_PATHS.has(path)) {
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
          // Forensic target is best-effort + NON-SECRET, extracted AFTER the
          // effect is fixed; a throwing getter costs only the descriptor.
          let descriptorTarget: string | undefined;
          try {
            descriptorTarget = spec?.targetFromArgs?.(callArgs);
          } catch {
            /* best-effort target — the gate still fires on the SOT write */
          }
          await gateMutatingEffect({
            pluginId: deps.pluginId,
            methodPath: path,
            effect,
            target: descriptorTarget,
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
  return wrapped as T;
}

/** @internal Test only — clears the process-lifetime descriptor grant memory. */
export function __resetEffectGrantsForTest(): void {
  descriptorGrants.clear();
}
