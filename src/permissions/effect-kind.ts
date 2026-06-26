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
  | "agentApprovalRespond";

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
