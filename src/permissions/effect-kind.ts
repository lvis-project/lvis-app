/**
 * Chokepoint effect vocabulary — the SINGLE SOURCE OF TRUTH for the
 * `kind → read/write` mapping that the effect-boundary model is built on.
 *
 * The observability stage (this PR) RECORDS host-mediated effects; a later
 * enforcement stage will ENFORCE on them. Both stages must agree on which host
 * chokepoint produces a read vs a write, so the mapping lives in ONE place
 * (CLAUDE.md Field-Addition Sweep): adding a chokepoint = add the union member +
 * its {@link CHOKEPOINT_EFFECT} entry, and the compiler enforces exhaustiveness.
 *
 * `EffectEntry.kind` is the {@link ChokepointKind} union (not a free-form
 * string) so a typo at a recording call-site is a type error, and the later
 * enforcement stage can switch on the union with exhaustiveness checking.
 */

/** Whether an observed host-mediated effect mutated state or only read it. */
export type Effect = "read" | "write";

/**
 * The closed set of host chokepoints whose effects the EffectLedger records.
 * Each member maps to a single read/write class via {@link CHOKEPOINT_EFFECT},
 * EXCEPT `hostFetch`, whose effect is derived from the HTTP verb the host owns
 * at the egress chokepoint (see {@link methodEffect}).
 *
 * `callTool-child` is the propagation marker the executor records on the OUTER
 * (wrapper) ledger when a re-entrant `callTool` delegates a MUTATING inner tool,
 * so a read-declared wrapper that mutates via delegation surfaces as a write on
 * its own ledger.
 */
export type ChokepointKind =
  | "config.get"
  | "config.set"
  | "getSecret"
  | "emitEvent"
  | "callTool"
  | "callTool-child"
  | "hostFetch"
  | "spawnWorker"
  | "openExternalUrl"
  // ─── PluginStorage (~/.lvis/plugins/<id>/) — the PRIMARY plugin persistence
  // path. A read records the host-observed ABSENCE of a mutation (dataset
  // completeness); the three write variants are what flip `hasMutatingEffect`.
  // Every host-mediated MUTATION chokepoint must record, else the executor's
  // `hostObservable:true` for an in-process plugin tool would be a lie — a
  // storage-only mutation would otherwise look like a confirmed host-observed
  // read (a fail-open seed for the future read-recognition gate).
  | "storageRead"
  | "storageWrite"
  | "storageRm"
  | "storageMkdir"
  // ─── Other host-mediated mutating chokepoints reached only via hostApi.
  // `clearAuthPartition` destructively wipes an Electron session partition;
  // `openAuthWindow` persists auth cookies/session; `triggerConversation`
  // stages an overlay prompt; `agentApprovalRespond` resolves a pending
  // approval. All mutate host-owned state, so all must record (see above).
  | "clearAuthPartition"
  | "openAuthWindow"
  | "triggerConversation"
  | "agentApprovalRespond"
  // ─── Structural-completeness vocabulary ────────────────────────────────
  // The full hostApi surface is now recorded STRUCTURALLY by a single
  // recording wrapper ({@link instrumentEffectsByPath}) that looks each method
  // PATH up in {@link HOSTAPI_EFFECT_BY_PATH}. Every function-valued hostApi
  // method maps to one of these kinds so no method can be silently
  // un-instrumented; the completeness test ({@link
  // ../__tests__/hostapi-effect-completeness.test.ts}) mechanically asserts the
  // mapping is total against the REAL hostApi object.
  //
  // WRITES — egress / persist / registry / session mutations:
  | "registerKeywords" // mutates the shared KeywordEngine routing registry
  | "callLlm" // body-bearing external LLM egress
  | "openAuthPartitionViewer" // silent-SSO load refreshes/persists partition cookies
  | "agentApprovalRequest" // registers an issuer entry + creates a pending gate entry
  // READS — pure reads / self-subscriptions / host telemetry (non-mutating):
  | "config.onChange" // self-subscription to observe a config key (auto-cleaned)
  | "onEvent" // self-subscription to a host event (auto-cleaned)
  | "onPluginsChanged" // self-subscription to lifecycle events (auto-cleaned)
  | "onShutdown" // registers a shutdown observer (host-scoped cleanup)
  | "getInstalledPluginIds" // reads the loaded-plugin id list
  | "getAppPreference" // reads an allow-listed host preference
  | "resolveApiKey" // leases/reads a host-managed credential (no persisted mutation)
  | "logEvent" // routes to the host AuditLogger (the telemetry channel itself)
  // FAIL-CLOSED sentinel — recorded for any hostApi method PATH absent from
  // {@link HOSTAPI_EFFECT_BY_PATH}. Conservatively MUTATING so a future-added
  // method can NEVER be a silent fail-open read; the completeness test forces
  // the method into the SOT, the sentinel is the runtime backstop until then.
  | "unclassifiedHostApiMethod";

/**
 * Chokepoints whose effect class is fixed (everything except `hostFetch`,
 * whose effect is verb-derived). Recording call-sites read the effect from this
 * map via {@link recordChokepoint} rather than repeating a string literal, so
 * the read/write classification has exactly one definition.
 */
export type StaticChokepointKind = Exclude<ChokepointKind, "hostFetch">;

/**
 * Static `kind → effect` mapping — the authoritative read/write classification
 * for the host chokepoints whose effect does not depend on a runtime argument.
 */
export const CHOKEPOINT_EFFECT: Record<StaticChokepointKind, Effect> = {
  "config.get": "read",
  "config.set": "write",
  getSecret: "read",
  // An emitted event is an in-memory bus signal that persists nothing on its own.
  emitEvent: "read",
  // Re-entering the executor opens a FRESH inner ledger; the inner tool's own
  // mutations are counted there. The outer ledger records only a nested READ
  // marker to avoid double-counting the same mutation.
  callTool: "read",
  // Propagation marker: an inner callTool whose inner ledger was MUTATING.
  "callTool-child": "write",
  spawnWorker: "write",
  openExternalUrl: "write",
  // PluginStorage — reads recorded for dataset completeness (positive read
  // evidence); writes/rm/mkdir mutate the plugin's persisted data.
  storageRead: "read",
  storageWrite: "write",
  storageRm: "write",
  storageMkdir: "write",
  // Host-mediated mutations reached only via hostApi closures.
  clearAuthPartition: "write",
  openAuthWindow: "write",
  triggerConversation: "write",
  agentApprovalRespond: "write",
  // Structural-completeness vocabulary — writes (egress / persist / registry).
  registerKeywords: "write",
  callLlm: "write",
  openAuthPartitionViewer: "write",
  agentApprovalRequest: "write",
  // Structural-completeness vocabulary — reads (pure reads / self-subscriptions
  // / host telemetry). A subscription registers the plugin to OBSERVE and is
  // auto-disposed on plugin disable, so it does not flip a tool to mutating;
  // `logEvent` is the host's own audit channel, not a plugin-domain mutation.
  "config.onChange": "read",
  onEvent: "read",
  onPluginsChanged: "read",
  onShutdown: "read",
  getInstalledPluginIds: "read",
  getAppPreference: "read",
  resolveApiKey: "read",
  logEvent: "read",
  // FAIL-CLOSED — an unmapped hostApi method is conservatively MUTATING.
  unclassifiedHostApiMethod: "write",
};

/** Method-safe verbs whose host-observed effect is a read. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Host-observed effect for a hostFetch egress, derived from the HTTP verb the
 * host holds at the chokepoint (NON-FORGEABLE — not from anything the plugin
 * self-declares). Safe verbs (GET/HEAD/OPTIONS) are reads; everything else is a
 * write. Observability only: this changes NO egress decision.
 */
export function methodEffect(method: string): Effect {
  return READ_METHODS.has(method.toUpperCase()) ? "read" : "write";
}

// ───────────────────────────────────────────────────────────────────────────
// Structural completeness — hostApi method PATH → effect classification SOT.
//
// The host asserts `hostObservable:true` for every in-process plugin tool, so
// EVERY function-valued hostApi method a plugin can call must record its
// host-observed effect — otherwise a mutation reached through an
// un-instrumented method yields an empty ledger and is recorded as a confirmed
// READ (a fail-open seed for the future read-recognition gate). Three rounds of
// per-closure manual instrumentation kept missing methods. This map makes the
// classification TOTAL: a single recording wrapper looks each invoked method up
// here by its dotted PATH (e.g. `"storage.writeJson"`, `"agentApproval.request"`,
// `"callLlm"`), and a completeness test mechanically asserts every real hostApi
// leaf is present here. The read/write CLASS still has exactly one definition
// ({@link CHOKEPOINT_EFFECT} / {@link methodEffect}); this map only assigns each
// method a {@link ChokepointKind}.
// ───────────────────────────────────────────────────────────────────────────

/**
 * How the recording wrapper classifies one hostApi method PATH.
 *
 * `kind` is the recorded {@link ChokepointKind} (whose read/write class comes
 * from {@link CHOKEPOINT_EFFECT}). `targetFromArgs` extracts a coarse,
 * NON-SECRET forensic descriptor (origin, config key, scope) — never a secret
 * value, body, or token.
 *
 * `selfRecorded` marks a chokepoint whose effect the GENERIC recorder must NOT
 * derive — the only one is `hostFetch`, the lone VERB-derived egress. Its
 * read/write class depends on a plugin-controlled arg VALUE (the HTTP method),
 * so deriving it in the recorder would read that value INDEPENDENTLY of the
 * wire: a stateful getter could return a safe verb to the recorder and a
 * mutating verb to the wire (a value-divergence forgery — a write recorded as a
 * confirmed read). A `selfRecorded` chokepoint instead snapshots the verb to a
 * primitive EXACTLY ONCE in its host closure and records the effect + pins the
 * wire from that single read, so the recorded effect == the wire verb by
 * construction. The generic recorder skips it (no second read, no double-record).
 */
export interface HostApiEffectSpec {
  kind: ChokepointKind;
  selfRecorded?: boolean;
  /**
   * DECLARED async-ness of the hostApi method at this path (it returns a
   * Promise). This is a CONTRACT property of the method, not a runtime guess —
   * the effect-boundary ENFORCEMENT layer awaits a user modal, which is only
   * possible at an ALREADY-async chokepoint, so it derives its gated set
   * MECHANICALLY from the write-classified paths that declare `async: true`
   * (see {@link writeClassifiedPaths} + `GATED_EFFECT_PATHS` in
   * effect-enforcement.ts). A write-classified path that is NOT async (the lone
   * one is `registerKeywords`) can never be gated by the await-based wrapper —
   * it MUST be an explicit enforcement exclusion, and the enforcement
   * completeness test fails if it is neither. The recorder ignores this field.
   */
  async?: boolean;
  targetFromArgs?: (args: readonly unknown[]) => string | undefined;
}

/** First positional arg, when it is a string (config key, storage rel path). */
function firstStringArg(args: readonly unknown[]): string | undefined {
  return typeof args[0] === "string" ? args[0] : undefined;
}

/** Capped key NAME (never the value) for secret reads — mirrors the audit cap. */
function cappedKeyArg(args: readonly unknown[]): string | undefined {
  return typeof args[0] === "string" ? args[0].slice(0, 64) : undefined;
}

/** ORIGIN-ONLY of a URL string arg — drops path/query that can carry tokens. */
function urlOriginArg(args: readonly unknown[]): string | undefined {
  if (typeof args[0] !== "string") return undefined;
  try {
    return new URL(args[0]).origin;
  } catch {
    return undefined;
  }
}

/** ORIGIN-ONLY of `args[0].url` (openAuthWindow / openAuthPartitionViewer). */
function urlOriginFromOpts(args: readonly unknown[]): string | undefined {
  const url = (args[0] as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A named string field of `args[0]` (e.g. trigger spec `source`, approval `scope`). */
function objectStringField(field: string) {
  return (args: readonly unknown[]): string | undefined => {
    const value = (args[0] as Record<string, unknown> | undefined)?.[field];
    return typeof value === "string" ? value : undefined;
  };
}

/**
 * COMPLETE classification SOT — every function-valued hostApi method PATH.
 *
 * Audited against `PluginHostApi` (`src/plugins/types.ts`) and the runtime
 * object built in `src/boot/steps/plugin-runtime.ts` + `src/plugins/storage.ts`.
 * Keys are the dotted leaf paths a plugin can invoke; nested namespaces
 * (`storage.*`, `config.*`, `agentApproval.*`) are flattened. The completeness
 * test fails if ANY real hostApi leaf is missing here; the wrapper's
 * fail-closed default (`unclassifiedHostApiMethod` = write) is the runtime
 * backstop for a method added before its SOT entry.
 */
export const HOSTAPI_EFFECT_BY_PATH: Record<string, HostApiEffectSpec> = {
  // ─── storage.* (PluginStorage) ───────────────────────────────────────────
  // resolve is a pure lexical path resolve (no IO) — recorded as a read for
  // total coverage; reads never flip `hasMutatingEffect`.
  "storage.resolve": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.read": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.readText": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.readJson": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.list": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.exists": { kind: "storageRead", targetFromArgs: firstStringArg },
  "storage.write": { kind: "storageWrite", async: true, targetFromArgs: firstStringArg },
  "storage.writeJson": { kind: "storageWrite", async: true, targetFromArgs: firstStringArg },
  "storage.rm": { kind: "storageRm", async: true, targetFromArgs: firstStringArg },
  "storage.mkdir": { kind: "storageMkdir", async: true, targetFromArgs: firstStringArg },
  // ─── config.* ─────────────────────────────────────────────────────────────
  "config.get": { kind: "config.get", targetFromArgs: firstStringArg },
  "config.set": { kind: "config.set", async: true, targetFromArgs: firstStringArg },
  "config.onChange": { kind: "config.onChange", targetFromArgs: firstStringArg },
  // ─── top-level reads / non-persisting signals ─────────────────────────────
  getSecret: { kind: "getSecret", targetFromArgs: cappedKeyArg },
  getInstalledPluginIds: { kind: "getInstalledPluginIds" },
  getAppPreference: { kind: "getAppPreference", targetFromArgs: firstStringArg },
  resolveApiKey: { kind: "resolveApiKey", targetFromArgs: objectStringField("purpose") },
  callTool: { kind: "callTool", targetFromArgs: firstStringArg },
  emitEvent: { kind: "emitEvent", targetFromArgs: firstStringArg },
  onEvent: { kind: "onEvent", targetFromArgs: firstStringArg },
  onPluginsChanged: { kind: "onPluginsChanged" },
  onShutdown: { kind: "onShutdown" },
  logEvent: { kind: "logEvent", targetFromArgs: firstStringArg },
  // ─── top-level writes (egress / persist / registry / session) ─────────────
  // registerKeywords is the LONE SYNCHRONOUS write chokepoint (returns void) —
  // deliberately NOT marked async, so the await-based enforcement wrapper can
  // never gate it (a sync→async conversion is a contract break). It is an
  // explicit enforcement exclusion instead; because it is still WRITE-classified
  // the recorder marks any tool that calls it as mutating, so the pre-exec ask
  // is retained (see effect-enforcement.ts ENFORCEMENT_EXCLUSIONS).
  registerKeywords: { kind: "registerKeywords" },
  // callLlm carries the prompt BODY to an external provider; target stays
  // undefined (the provider is not in args and the prompt is never a target).
  callLlm: { kind: "callLlm", async: true },
  // hostFetch is the ONLY verb-derived chokepoint: its read/write class comes
  // from the HTTP method, a plugin-controlled arg VALUE. `selfRecorded` keeps the
  // generic recorder from re-reading that value (which would diverge from the
  // wire); the hostFetch host closure snapshots the verb ONCE and records the
  // effect + target + pins the wire from that single read (plugin-runtime.ts).
  // It is async but `selfRecorded`, so enforcement gates it INLINE in that same
  // closure (an enforcement exclusion for the generic wrapper).
  hostFetch: { kind: "hostFetch", selfRecorded: true, async: true },
  spawnWorker: { kind: "spawnWorker", async: true },
  openExternalUrl: { kind: "openExternalUrl", async: true, targetFromArgs: urlOriginArg },
  openAuthWindow: { kind: "openAuthWindow", async: true, targetFromArgs: urlOriginFromOpts },
  openAuthPartitionViewer: { kind: "openAuthPartitionViewer", async: true, targetFromArgs: urlOriginFromOpts },
  clearAuthPartition: { kind: "clearAuthPartition", async: true, targetFromArgs: firstStringArg },
  triggerConversation: { kind: "triggerConversation", async: true, targetFromArgs: objectStringField("source") },
  // ─── agentApproval.* ──────────────────────────────────────────────────────
  "agentApproval.request": {
    kind: "agentApprovalRequest",
    async: true,
    targetFromArgs: objectStringField("scope"),
  },
  // No target — requestId is an internal correlation handle, not a pivot value.
  "agentApproval.respond": { kind: "agentApprovalRespond", async: true },
};

/**
 * The host-observed effect CLASS for one hostApi method PATH, resolved from the
 * SOT — `"verb-derived"` for the lone `selfRecorded` chokepoint (hostFetch,
 * whose read/write depends on the HTTP verb at the wire), `undefined` for a path
 * absent from the SOT. The read/write class for a static chokepoint comes from
 * {@link CHOKEPOINT_EFFECT} (fail-closed `"write"` if a kind is somehow unmapped,
 * mirroring the recorder), never from a plugin-controlled arg.
 */
export function pathEffectClass(path: string): Effect | "verb-derived" | undefined {
  const spec = HOSTAPI_EFFECT_BY_PATH[path];
  if (!spec) return undefined;
  // hostFetch — verb-derived: it CAN be a write (any non GET/HEAD/OPTIONS), so
  // it is treated as write-classified for completeness (it is enforcement-gated
  // inline, not by the generic wrapper).
  if (spec.selfRecorded) return "verb-derived";
  return CHOKEPOINT_EFFECT[spec.kind as StaticChokepointKind] ?? "write";
}

/**
 * MECHANICALLY-derived set of every hostApi method PATH whose host-observed
 * effect is (or can be) a WRITE — the universe the effect-boundary ENFORCEMENT
 * layer must account for. Every member must be either effect-gated
 * (`GATED_EFFECT_PATHS`) or an explicit, documented enforcement exclusion
 * (`ENFORCEMENT_EXCLUSIONS`); the enforcement completeness test asserts that
 * partition is total, so a future write chokepoint added to
 * {@link HOSTAPI_EFFECT_BY_PATH} can never silently ship UN-enforced (fail-closed
 * by construction). Derived from {@link CHOKEPOINT_EFFECT} / verb-derived, never
 * hand-maintained.
 */
export function writeClassifiedPaths(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const path of Object.keys(HOSTAPI_EFFECT_BY_PATH)) {
    const cls = pathEffectClass(path);
    if (cls === "write" || cls === "verb-derived") out.add(path);
  }
  return out;
}
