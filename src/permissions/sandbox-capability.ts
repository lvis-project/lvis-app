/**
 * OS-level execution sandbox capability — single source of truth.
 *
 * Spec ref: docs/architecture/permission-policy-design.md (sandbox capability layer)
 * Issue: #691 (sandbox capability + reviewer SOT integration)
 *
 * Why this module exists:
 *   The permission stack (Layer 0 deny / Layer 1 directory allow / Layer 3
 *   approval gate / Layer 5 reviewer) protects against accidental dangerous
 *   tool calls, but none of those layers physically isolate the *executed*
 *   shell command from the host filesystem. A reviewer that downgrades a
 *   tool call from HIGH to LOW based solely on intent is missing half the
 *   picture — without OS-level isolation, "low intent + no sandbox" is
 *   still a meaningful residual risk.
 *
 *   This module is the SOT the reviewer consults. The reviewer prompt is
 *   updated to honor a composition rule: "if executionSandbox.kind === 'none',
 *   the LLM MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW
 *   purely on intent."
 *
 * How the capability is resolved:
 *   OS isolation is now backed by the Anthropic Sandbox Runtime (ASRT) —
 *   see asrt-sandbox.ts. The legacy per-OS runner registry
 *   (bwrap / sandbox-exec / AppContainer) was removed; ASRT provides the
 *   host-tool filesystem jail + global strict-union network enforcement. When
 *   the ASRT path is active it reports `kind: "asrt"`; the SOT falls back to
 *   `kind: "none"` (confidence: "verified") when the sandbox gate is off
 *   (DEFAULT) — the reviewer + UI then correctly report the absence of OS
 *   isolation. The active capability is published via
 *   `setActiveSandboxCapability`. The audit chain currently stores the reviewer
 *   verdict derived from this value, not the full SandboxCapability snapshot.
 */

import { t } from "../i18n/index.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { SandboxConfinement } from "../shared/sandbox-capability-info.js";

// RENDERER-SAFETY: this module is imported by the renderer (ToolApprovalDialog
// uses isWeakSandbox / the types), so it MUST NOT statically import
// `asrt-sandbox.js` — that package (`@anthropic-ai/sandbox-runtime`) pulls Node
// built-ins (`fs`/`child_process`/`net`) into the renderer webpack bundle. The
// "is a server genuinely wrapped" signal therefore comes from the MAIN-process
// wrapped registry below (only StdioTransport, main-only, populates it) plus the
// active capability snapshot — never a direct gate call into asrt-sandbox.

export type SandboxKind =
  | "none"
  /** OS isolation provided by the Anthropic Sandbox Runtime (ASRT). Backend is
   * bwrap on Linux, Seatbelt on macOS (both full-confine), and srt-win on
   * Windows (NETWORK-ONLY — no filesystem jail). All report as a single `asrt`
   * kind; the per-substrate `confines` field distinguishes full vs network-only,
   * which is what {@link sandboxRelaxesCategory} reads for Windows. */
  | "asrt"
  /** OS-level isolation present but evidence quality is PARTIAL. */
  | "partial"
  /** Filesystem-only isolation (landlock-only — future-proofing for Linux landlock runner). */
  | "fs-only";

/**
 * Confidence in the detection result.
 *
 *   - "verified"          — actively checked (binary present + invocable, OS API
 *     reports the process is sandboxed, etc.).
 *   - "assumed"           — inferred from platform without active probe (used
 *     when a probe is expensive or not yet implemented).
 *   - "policy-best-effort" — binary confirmed present + executable, but the
 *     sandbox profile is a best-effort policy with known bypass paths;
 *     enforcement is weaker than "verified". Reserved for a future PARTIAL
 *     backend; no current platform reports this (macOS + Linux are verified
 *     ASRT). Distinguishes a best-effort policy from "assumed".
 */
export type SandboxConfidence = "verified" | "assumed" | "policy-best-effort";

export interface SandboxCapability {
  kind: SandboxKind;
  confidence: SandboxConfidence;
  /** NodeJS.Platform value at detection time. Useful for audit replay. */
  platform: NodeJS.Platform;
  /** Short human-readable explanation, surfaced to UI + reviewer prompt. */
  reason: string;
  /**
   * What this capability ACTUALLY confines (filesystem / process / network),
   * for the substrate it describes. Machine-checkable so network honesty is
   * auditable and future per-substrate enforcement can assert against it.
   *
   * Optional so existing callers/fixtures that only assert kind/confidence
   * remain valid; the honest producers ({@link setActiveSandboxCapability}
   * publish site + the substrate-aware resolver) populate it. Absence means
   * "not declared" — callers MUST NOT read absence as "all confined".
   */
  confines?: SandboxConfinement;
}

/**
 * Active capability cache. Set by {@link setActiveSandboxCapability} when the
 * ASRT sandbox path is initialized at boot. Defaults to `undefined` (the SOT
 * then reports `kind: "none"`).
 */
let _activeCapability: SandboxCapability | undefined;

/**
 * Store the active sandbox capability after the ASRT sandbox is initialized at
 * boot. Subsequent calls to detectSandboxCapability return this value.
 *
 * @internal — only the boot-time ASRT init path and tests should call this.
 */
export function setActiveSandboxCapability(cap: SandboxCapability): void {
  _activeCapability = cap;
}

/**
 * Reset the active capability cache. Used by test teardown.
 * @internal
 */
export function __resetActiveSandboxCapabilityForTest(): void {
  _activeCapability = undefined;
}

/**
 * Detect the OS execution sandbox available to spawned shell commands.
 *
 * Returns the capability stored by {@link setActiveSandboxCapability} when the
 * ASRT sandbox path was initialized at boot. Falls back to kind="none" when no
 * sandbox is active (the gate is DEFAULT-OFF; isolation=none).
 *
 * This is the single SOT the reviewer and UI consult — all callers automatically
 * see the correct kind once ASRT is active without re-probing the OS.
 */
export function detectSandboxCapability(): SandboxCapability {
  if (_activeCapability) {
    return _activeCapability;
  }
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "no OS sandbox configured for the host process",
  };
}

/**
 * Tool names whose effects run on the ASRT-wrapped host-shell substrate.
 *
 * ONLY the `bash` / `powershell` builtin shell tools route their workload
 * through {@link wrapToolCommand} (→ `spawnWithSandbox` in bash.ts /
 * powershell.ts), which is the per-command OS jail. Every other execution
 * substrate is NOT ASRT-wrapped:
 *   - `mcp` tools run in the LONG-LIVED MCP worker. EXTERNAL stdio servers
 *     are wrapped via `wrapWorkerCommand` in `StdioTransport.openWrapped`
 *     (worker-egress PR1) when the gate is ON; per-server confinement is
 *     reported through the wrapped-registry below. Plugin loopback servers
 *     use `LoopbackTransport` (in-process) — not ASRT-wrapped.
 *   - other `builtin` tools (read_file, write_file, list_files, …) run
 *     IN-PROCESS in the host — no OS jail either.
 */
const ASRT_WRAPPED_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * The set of EXTERNAL MCP stdio server ids whose worker was ACTUALLY spawned
 * through the ASRT wrap in THIS process (worker-egress PR1).
 *
 * Populated by {@link markMcpServerWrapped} from `StdioTransport.openWrapped`
 * only on the wrapped path, and cleared by {@link unmarkMcpServerWrapped} on
 * transport close (or a failed wrap). This is the per-server "wrapped" signal
 * {@link resolveReviewerSandboxCapability} consults so an MCP tool call reports
 * the GENUINE asrt capability ONLY for a server that is genuinely confined —
 * an unwrapped server (gate off, wrap failed, pre-existing) still reports
 * `none`. Membership here is necessary but NOT sufficient: the resolver also
 * re-checks {@link detectSandboxCapability} so a torn-down sandbox cannot leave
 * a stale `asrt` report.
 */
const _wrappedMcpServerIds = new Set<string>();

/**
 * Record that `serverId`'s stdio worker was spawned through the ASRT wrap.
 * @internal — only StdioTransport's wrapped-spawn path and tests call this.
 */
export function markMcpServerWrapped(serverId: string): void {
  _wrappedMcpServerIds.add(serverId);
}

/**
 * Drop `serverId`'s wrapped marker (transport closed or wrap failed). Idempotent.
 * @internal — only StdioTransport and tests call this.
 */
export function unmarkMcpServerWrapped(serverId: string): void {
  _wrappedMcpServerIds.delete(serverId);
}

/**
 * Whether `serverId`'s worker is currently wrapped through ASRT.
 * @internal — exported for the reviewer resolver + tests.
 */
export function isMcpServerWrapped(serverId: string): boolean {
  return _wrappedMcpServerIds.has(serverId);
}

/**
 * Drop every wrapped-MCP-server marker. Called by {@link resetAsrtSandbox} on
 * sandbox teardown so no stale `asrt` signal survives, and by test teardown.
 * @internal
 */
export function clearWrappedMcpServers(): void {
  _wrappedMcpServerIds.clear();
}

/**
 * Reset the wrapped-MCP-server registry. Test teardown only.
 * @internal
 */
export function __resetWrappedMcpServersForTest(): void {
  clearWrappedMcpServers();
}

/**
 * The set of PLUGIN WORKER ids whose long-lived worker was ACTUALLY spawned
 * through the ASRT wrap in THIS process (worker-confinement via UDS — PR D-1).
 *
 * This mirrors {@link _wrappedMcpServerIds} for the OTHER long-lived worker
 * substrate: a `source === 'plugin'` tool whose side-effects run in a
 * host-spawned, ASRT-wrapped plugin worker ({@link spawnWorker} in
 * worker-spawn.ts). Populated by {@link markPluginWorkerWrapped} from the
 * wrapped-spawn path (gate ON + wrap succeeded) and cleared by
 * {@link unmarkPluginWorkerWrapped} on any worker exit / stop / failed wrap.
 *
 * This is the per-worker "wrapped" signal {@link resolveReviewerSandboxCapability}
 * consults so a plugin tool call reports the GENUINE asrt capability ONLY for a
 * worker that is genuinely confined — an unwrapped worker (gate off, wrap
 * failed, win32 legacy path, or a plugin with no host-spawned worker) stays
 * `none`. Membership is necessary but NOT sufficient: the resolver also
 * re-checks {@link detectSandboxCapability} so a torn-down sandbox cannot leave
 * a stale `asrt` report (the #1359/#1364 no-leak invariant).
 */
const _wrappedPluginWorkerIds = new Set<string>();

/**
 * Record that `workerId`'s plugin worker was spawned through the ASRT wrap.
 * @internal — only {@link spawnWorker}'s wrapped-spawn path and tests call this.
 */
export function markPluginWorkerWrapped(workerId: string): void {
  _wrappedPluginWorkerIds.add(workerId);
}

/**
 * Drop `workerId`'s wrapped marker (worker exited / stopped / wrap failed).
 * Idempotent.
 * @internal — only {@link spawnWorker} and tests call this.
 */
export function unmarkPluginWorkerWrapped(workerId: string): void {
  _wrappedPluginWorkerIds.delete(workerId);
}

/**
 * Whether `workerId`'s plugin worker is currently wrapped through ASRT.
 * @internal — exported for the reviewer resolver + tests.
 */
export function isPluginWorkerWrapped(workerId: string): boolean {
  return _wrappedPluginWorkerIds.has(workerId);
}

/**
 * Drop every wrapped-plugin-worker marker. Called by {@link resetAsrtSandbox}
 * on sandbox teardown so no stale `asrt` signal survives, and by test teardown.
 * @internal
 */
export function clearWrappedPluginWorkers(): void {
  _wrappedPluginWorkerIds.clear();
}

/**
 * Reset the wrapped-plugin-worker registry. Test teardown only.
 * @internal
 */
export function __resetWrappedPluginWorkersForTest(): void {
  clearWrappedPluginWorkers();
}

/**
 * Resolve the sandbox capability to feed the reviewer/risk-classifier for a
 * SPECIFIC tool call, reflecting that call's EXECUTION SUBSTRATE rather than
 * the process-global capability.
 *
 * THE INVARIANT (security): the `asrt` reviewer relaxation
 * ({@link isWeakSandbox} === false) must apply ONLY to executions GENUINELY
 * isolated by ASRT. The process-global {@link detectSandboxCapability} reports
 * `asrt` once the boot gate is ON, but that only describes the host-shell
 * substrate — plugin/MCP tool side-effects run in the unwrapped long-lived
 * worker (isolation=none), and in-process builtin tools are not jailed either.
 * Presenting the global `asrt` for those calls would let the LLM downgrade a
 * MEDIUM/HIGH verdict to LOW (auto-approve) for an UNSANDBOXED effect — the
 * exact opposite of enabling the sandbox.
 *
 * Mapping:
 *   - `builtin` + tool ∈ {bash, powershell} → the genuine
 *     {@link detectSandboxCapability} (the ASRT-wrapped shell path; `asrt`
 *     when the gate is ON, already `none` when it is OFF).
 *   - `mcp` + the originating server was ACTUALLY wrapped through ASRT
 *     (worker-egress PR1: gate ON + {@link isAsrtSandboxActive} +
 *     {@link isMcpServerWrapped}) → the genuine {@link detectSandboxCapability}
 *     (the wrapped worker IS confined — mac/linux full, win32 network-only).
 *   - `plugin` + the originating worker was ACTUALLY wrapped through ASRT
 *     (worker-confinement PR D-1: gate ON + {@link isPluginWorkerWrapped}) →
 *     the genuine {@link detectSandboxCapability} (the host-spawned plugin
 *     worker IS confined; see {@link spawnWorker}). Requires `workerId`.
 *   - everything else (UNWRAPPED plugin, UNWRAPPED mcp, other builtin) → a
 *     forced `none` capability so {@link isWeakSandbox} treats the call as WEAK
 *     and the reviewer cannot relax.
 *
 * NO-LEAK INVARIANT (the #1359 review catch): never report `asrt` for a worker
 * this process did not wrap. An MCP server / plugin worker reports `asrt` ONLY
 * when its specific id is in the corresponding wrapped registry AND the sandbox
 * is still active — a gate-off, wrap-failed, win32-legacy, or pre-existing
 * unwrapped worker stays `none`.
 *
 * @param mcpServerId  Originating MCP server id, threaded from `Tool.mcpServerId`.
 *                     Required to report `asrt` for an `mcp` call; omitted ⇒ the
 *                     call resolves to `none` (the historical default), so every
 *                     pre-existing call site keeps its exact behaviour.
 * @param workerId     Originating plugin-worker id, threaded from the plugin
 *                     tool descriptor (PR D-3 wires the producer). Required to
 *                     report `asrt` for a `plugin` call; omitted ⇒ the call
 *                     resolves to `none` (the historical default for plugin
 *                     tools), so every pre-existing call site is unchanged.
 */
export function resolveReviewerSandboxCapability(
  source: ToolSource,
  toolName: string,
  mcpServerId?: string,
  workerId?: string,
): SandboxCapability {
  if (source === "builtin" && ASRT_WRAPPED_SHELL_TOOLS.has(toolName)) {
    return detectSandboxCapability();
  }
  // worker-confinement PR D-1: a wrapped host-spawned plugin worker genuinely
  // runs under ASRT — report its real capability so the reviewer composition
  // reflects the actual confinement (not the false `none` the unwrapped worker
  // earned). Same TWO main-process-only signals as the MCP branch: (1) the
  // worker id is in the plugin-worker wrapped registry (only populated by
  // spawnWorker's wrapped path, cleared on exit/stop/failure/teardown); (2) the
  // active capability is a genuine verified `asrt`. Both must hold (no-leak).
  if (source === "plugin" && workerId !== undefined && isPluginWorkerWrapped(workerId)) {
    const active = detectSandboxCapability();
    if (active.kind === "asrt") {
      return {
        ...active,
        reason: `plugin worker '${workerId}' ASRT-wrapped — ${active.reason}`,
      };
    }
  }
  // worker-egress PR1: a wrapped external MCP stdio worker genuinely runs under
  // ASRT — report its real capability so the reviewer composition reflects the
  // actual confinement (and not the false `none` the unwrapped worker earned).
  //
  // Liveness is established by TWO main-process-only signals, no renderer-unsafe
  // gate call: (1) the server id is in the wrapped registry — only populated by
  // StdioTransport's wrapped-spawn path (gate ON + wrap succeeded) and cleared on
  // close/failure/teardown; (2) the active capability is a genuine verified
  // `asrt` — published by boot and cleared on {@link resetAsrtSandbox}. Both must
  // hold, so a torn-down sandbox (active reset) or an unwrapped server (not in the
  // registry) falls through to `none` (no-leak invariant).
  if (source === "mcp" && mcpServerId !== undefined && isMcpServerWrapped(mcpServerId)) {
    const active = detectSandboxCapability();
    if (active.kind === "asrt") {
      return {
        ...active,
        reason: `external MCP stdio worker '${mcpServerId}' ASRT-wrapped — ${active.reason}`,
      };
    }
  }
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason:
      source === "builtin"
        ? "in-process builtin tool — not ASRT-wrapped (isolation=none)"
        : "plugin/MCP worker not ASRT-wrapped (isolation=none)",
    confines: { filesystem: false, process: false, network: false },
  };
}

/**
 * Format the capability for inclusion in the reviewer LLM prompt.
 *
 * The format is stable + grep-able so the reviewer's response can be
 * audited against the input that produced it. Example output:
 *
 *   "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process"
 *
 * When the capability declares {@link SandboxCapability.confines}, the
 * per-dimension confinement is appended so the reviewer LLM sees an HONEST
 * picture of what is (and is NOT) jailed — e.g. a Windows network-only ASRT
 * confines egress but not the filesystem, and the LLM must not relax a
 * filesystem-write risk on the strength of a network jail:
 *
 *   "executionSandbox=asrt (verified, win32) confines[net:✓ fs:✗ proc:✗] — …"
 *
 * The suffix is omitted when `confines` is absent (legacy/`none` capabilities)
 * so the historical grep-stable strings are preserved.
 *
 * Labels for extended kinds:
 *   partial  → "⚠ OS 격리 부분적"
 *   fs-only  → "ℹ 파일시스템만 격리 (landlock)"
 */
export function formatSandboxCapabilityForPrompt(capability: SandboxCapability): string {
  const kindLabel = (() => {
    switch (capability.kind) {
      case "none":         return "none";
      case "asrt":         return "asrt";
      case "partial":      return t("be_sandboxCapability.partialLabel");
      case "fs-only":      return t("be_sandboxCapability.fsOnlyLabel");
      default: {
        // Exhaustive check — if a new SandboxKind is added without updating
        // this switch, the TypeScript compiler will report an error here.
        const _exhaustive: never = capability.kind;
        return _exhaustive;
      }
    }
  })();
  const confinesLabel = capability.confines
    ? ` confines[net:${capability.confines.network ? "✓" : "✗"} ` +
      `fs:${capability.confines.filesystem ? "✓" : "✗"} ` +
      `proc:${capability.confines.process ? "✓" : "✗"}]`
    : "";
  return (
    `executionSandbox=${kindLabel} (${capability.confidence}, ${capability.platform})` +
    `${confinesLabel} — ${capability.reason}`
  );
}

/**
 * Returns true when the capability is "weak" — i.e. the LLM reviewer
 * MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW on this
 * invocation. Centralised here so the reviewer + audit + UI agree.
 *
 *   - `kind === "none"`          → weak (no isolation)
 *   - `kind === "partial"`       → weak (partial isolation = evidence gap)
 *   - `confidence === "assumed"` → weak (unverified isolation = no isolation)
 *
 * `fs-only` is NOT weak — it is strong-for-fs. The composition rule
 * handles network egress separately for fs-only runners.
 * Anything else (verified `asrt`) is "strong".
 */
export function isWeakSandbox(cap: SandboxCapability): boolean {
  if (cap.kind === "none") return true;
  if (cap.kind === "partial") return true;
  if (cap.confidence === "assumed") return true;
  return false;
}

/**
 * Whether the reviewer may relax (allow an LLM downgrade of a rule-based
 * MEDIUM/HIGH verdict to LOW) for a tool call of the given {@link ToolCategory}
 * under this capability — per-CATEGORY, gated on the matching `confines`
 * dimension.
 *
 * Why per-category (and not the binary {@link isWeakSandbox}):
 *   {@link isWeakSandbox} is confines-BLIND — it returns "strong" for ANY
 *   verified non-none ASRT capability, which is correct only while every ASRT
 *   substrate is FULL-confine (mac/linux: {filesystem, process, network} all
 *   true). A NETWORK-ONLY ASRT (Windows: confines.filesystem === false) is
 *   genuinely strong for egress but provides NO filesystem jail — so the
 *   reviewer must NOT relax a filesystem-WRITE risk on its strength. This gates
 *   the relaxation on the dimension that actually covers the category:
 *     - `network`                       → confines.network
 *     - `write` / `shell` / `read` / `meta` (all filesystem-bearing effects)
 *                                        → confines.filesystem
 *
 * Behaviour invariant (dormancy): a full-confine ASRT relaxes ALL categories,
 * making this IDENTICAL to today's `isWeakSandbox(cap) === false` (relax all).
 * The only capability the category gating bites is a PARTIAL-confine one, which
 * no producer emits yet — so wiring this in is a no-op on mac/linux.
 */
export function sandboxRelaxesCategory(
  cap: SandboxCapability,
  category: ToolCategory,
): boolean {
  // none/partial/assumed never relax — unchanged from the binary gate.
  if (isWeakSandbox(cap)) return false;
  // LEGACY: a verified non-none capability WITHOUT a declared `confines` field
  // keeps the old all-or-nothing behaviour, so existing fixtures and
  // mac/linux-verified ASRT (published with full confines) are unaffected.
  if (!cap.confines) return true;
  if (category === "network") return cap.confines.network === true;
  // write / shell / read / meta — all filesystem-bearing effects.
  return cap.confines.filesystem === true;
}
