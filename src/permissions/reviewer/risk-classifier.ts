/**
 * Permission policy Layer 5 Reviewer Agent: RiskClassifier interface + impls.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions (default `provider="openai"`,
 * `model="gpt-4o-mini"`; `fallbackOnError ∈ {deny, rule}`; default fail-closed;
 * verdict
 * composition `final = max(rule, llm)`; DLP filter on classifier input).
 *
 * Four implementations selected by mode:
 *   - `disabled` → DisabledRiskClassifier — always LOW (reviewer lane bypassed,
 *     per-tool category × source × trust matrix still applies).
 *     Issue #664: pre-fix this was wired as "defer-all-HIGH" which contradicted
 *     the name and broke wrapper UX (plugin auth/write silently queued forever).
 *     Fail-closed semantics moved to {@link StrictRiskClassifier}.
 *   - `rule`     → RuleBasedRiskClassifier — deterministic 36-rule
 *     heuristic (4 categories × 3 dir-relations × 3 confidence levels).
 *   - `llm`      → LlmRiskClassifier — multi-vendor LLM call. Always
 *     runs RuleBased first; takes `max(ruleVerdict, llmVerdict)`
 *     (LLM cannot downgrade).
 *   - `strict`   → StrictRiskClassifier — always HIGH + defer-all. Use this for
 *     hardened deployments where every headless mutation must be manually
 *     approved. Equivalent to the pre-#664 "disabled" semantic.
 *
 * Interface is sync-friendly union (`RiskVerdict | Promise<RiskVerdict>`)
 * so callers using only the rule classifier do not pay an event-loop
 * round-trip per invocation.
 *
 * No fallback shim: if `mode: "llm"` is configured but the provider or
 * model is missing, {@link createRiskClassifier} throws at boot — this
 * is the documented atomic-cutover behaviour (CLAUDE.md No-Fallback).
 */
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../../tools/types.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import { PERMISSION_REVIEWER_SYSTEM_PROMPT } from "../../shared/permission-reviewer-framework.js";
import { getDottedFieldValue } from "../../shared/dotted-field-value.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
import {
  formatSandboxCapabilityForPrompt,
  sandboxRelaxesCategory,
  type SandboxCapability,
} from "../sandbox-capability.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../sensitive-paths.js";
import { isPathAllowed } from "../allowed-directories.js";
import {
  extractNetworkTarget,
  NETWORK_TARGET_FIELDS,
  type NetworkTarget,
} from "./network-target.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";

/** Verdict level — discrete enum. The reviewer lane never uses scalars. */
export type RiskLevel = "low" | "medium" | "high";

/** Verdict shape returned by every classifier. */
export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
  /**
   * This verdict means "the host could not determine what this call does" —
   * NOT "the host determined it is mildly risky". A person has to answer it.
   *
   * The distinction needs its own axis because `level` is not one gate, it is
   * the key to three that read it independently:
   *   (a) UI persistability — "Always allow" is disabled on HIGH
   *       (`ToolApprovalContent`).
   *   (b) the foreground auto-approve threshold — `interactive.autoApprove`
   *       ships as `"medium"`, so a MEDIUM allows with NO prompt at all
   *       (`PermissionManager.resolveReviewerDecision`).
   *   (c) the parent-adjudication ceiling — `ParentAdjudicationMaxVerdict` is
   *       `"low" | "medium"`, HIGH excluded FROM THE TYPE precisely so a child
   *       agent's call in that class always reaches a person (`ApprovalGate`).
   *
   * A verdict that lands below HIGH to become answerable-once (a) would
   * otherwise also become auto-executable (b) and agent-approvable (c). This
   * flag keeps (b) and (c) shut while (a) opens, so "unknown" can be answered
   * by a human once instead of being asked forever OR waved through silently.
   */
  requiresExplicitApproval?: boolean;
}

export interface LlmRiskClassificationTrace {
  ruleVerdict: RiskVerdict;
  llmVerdict: RiskVerdict | null;
  finalVerdict: RiskVerdict;
  outcome: "fresh" | "host-determined" | "error" | "timeout" | "malformed";
}
export type ReviewerDispatchErrorCode = "timeout" | "error";

export class ReviewerDispatchError extends Error {
  constructor(
    readonly code: ReviewerDispatchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewerDispatchError";
  }
}

function reviewerFailureOutcome(error: unknown): "timeout" | "error" {
  if (error instanceof ReviewerDispatchError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "error";
}


/** Numeric ordering for `final = max(rule, llm)`. */
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Pick the higher-rank verdict. Ties prefer `b` (LLM) for reason text. */
export function maxVerdict(a: RiskVerdict, b: RiskVerdict): RiskVerdict {
  return LEVEL_RANK[b.level] >= LEVEL_RANK[a.level] ? b : a;
}

/**
 * Per-invocation context passed into a classifier.
 *
 * `finalInput` is RAW and must stay raw: every classifier rule grades it, and a
 * rule that grades DLP-masked text grades data that does not exist. Masking a
 * value can destroy the very signal a rule keys on — `https://live-corp.openai.
 * azure.com/x` masks to `https://[REDACTED:TOKEN].openai.azure.com/x`, which no
 * longer parses as a URL, so the trusted-host rule stops matching and the call
 * rates HIGH instead of LOW. Pre-masking on one lane and not another is how the
 * same call got two different verdicts.
 *
 * DLP is applied at the SINKS, not at the input: {@link buildUserPrompt} masks
 * every value before the reviewer LLM sees it (so a secret never reaches the
 * provider), the deferred queue and the sandbox audit mask before writing.
 */
export interface ToolInvocationContext {
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  /** Manifest-declared path-bearing argument selectors. Dotted selectors are supported. */
  pathFields: readonly string[];
  /**
   * Permission policy §9 trust origin. Surfaced in the LLM prompt so the classifier
   * can reason about prompt-injection risk: an `llm-tool-arg` write of
   * the same shape as a `user-keyboard` write is meaningfully different.
   */
  trustOrigin: ToolTrustOrigin;
  finalInput: Record<string, unknown>;
  /**
   * The cwd the tool will actually execute against — the SAME value the
   * enforcer resolves path arguments with
   * (`extractTargetFilePaths(tool, finalInput, executionCwd)`).
   *
   * REQUIRED, deliberately: this is the second half of
   * {@link resolveToolPathForPermission}'s contract, and an optional field
   * with a `process.cwd()` fallback is exactly the divergence this replaced —
   * the reviewer would silently judge a different file than Layer 1 checks.
   * Making it required means the compiler, not a code reviewer, catches a
   * producer that forgets to thread it.
   */
  executionCwd: string;
  allowedDirectories: string[];
  /** Adjacent sensitive entries (e.g. `.env`, `.git`) detected near the path. */
  sensitivePathsAdjacent: string[];
  /**
   * OS-level execution sandbox capability — the reviewer SOT for issue
   * #691. Constructed by {@link resolveReviewerSandboxCapability} at the
   * dispatch site (single producer) and threaded here so the LLM prompt sees
   * the same value used by the reviewer. The current audit schema records the
   * resulting reviewer verdict, not the full SandboxCapability snapshot.
   * Required: callers MUST supply it so a missing field cannot silently
   * downgrade the reviewer's safety posture.
   */
  sandboxCapability: SandboxCapability;
  /**
   * Conversation context for context-quality no-downgrade rule.
   * Only `recentUserMessage` is consulted — the heuristic in
   * {@link isContextMissingIntent} treats an absent or short (<5 chars)
   * message as "weak context", preventing the LLM from downgrading a
   * rule-based MEDIUM/HIGH verdict to LOW.
   *
   * Optional so that existing callers do not require immediate updates.
   * Absence is treated as weak context (conservative).
   */
  conversationContext?: {
    recentUserMessage?: string;
  };
  /**
   * Issue #664 P1 — HOST-derived sandbox-write auto-LOW signal.
   *
   * `ownerPluginSandboxRoot` is the absolute directory path the owning plugin
   * tool is permitted to write inside without triggering reviewer escalation:
   * `~/.lvis/plugins/<ownerPluginId>/data`, computed HOST-side by the executor
   * at tool-invocation time (`resolvePluginWritableRoot(pluginId)`) — never a
   * manifest value. It is the plugin's DATA directory, not its root: the root
   * holds the installed bundle, and an auto-LOW there would rubber-stamp a
   * plugin rewriting the module the next load imports. For builtin tools, or
   * where the contract declares no sandbox, leave undefined and the normal
   * write rules apply. The path participates in the verdict-cache identity so
   * a plugin rename/reinstall that changes the sandbox root invalidates a
   * cached LOW.
   *
   * #885 v6 (Q4): the old manifest-declared `writesToOwnSandbox` self-attestation
   * is REMOVED — it was an untrusted self-claim (MCP "annotations untrusted"); a
   * lying `true` never bypassed anything because the REAL check was always the
   * host path-containment proof (every resolved path inside this root). The
   * auto-LOW now keys SOLELY on this host-computed root + host-verified
   * containment — 100% host-derived, no self-claim participates.
   */
  ownerPluginSandboxRoot?: string;
}

export interface RiskClassifier {
  classify(input: ToolInvocationContext): RiskVerdict | Promise<RiskVerdict>;
}

// ─── DisabledRiskClassifier ───────────────────────────────────────────

/**
 * Reviewer disabled — every dispatch returns LOW so the reviewer lane is a
 * no-op. The per-tool category × source × trust matrix in
 * {@link PermissionManager} (deny rules, allowed-dir checks, overlay-trigger
 * guards, explicit approval dock) is unaffected.
 *
 * Issue #664: pre-fix this classifier returned HIGH+"defer all" which silently
 * queued every plugin write/auth tool in the headless lane (an auth/sign-in
 * tool from the Microsoft Graph plugin was the original reproducer).
 * The name contradicted the behaviour and broke wrapper UX.
 * Fail-closed semantics moved to {@link StrictRiskClassifier}.
 */
export class DisabledRiskClassifier implements RiskClassifier {
  classify(_: ToolInvocationContext): RiskVerdict {
    return { level: "low", reason: "reviewer disabled — pass-through" };
  }
}

// ─── StrictRiskClassifier ─────────────────────────────────────────────

/**
 * Fail-closed reviewer — every dispatch returns HIGH so headless mutations
 * land in the deferred queue. Use this for hardened deployments where the
 * user wants to manually approve every plugin/MCP write before it executes.
 *
 * Equivalent to the pre-#664 "disabled" semantic but under an honest name.
 */
export class StrictRiskClassifier implements RiskClassifier {
  classify(_: ToolInvocationContext): RiskVerdict {
    return { level: "high", reason: "reviewer strict — defer all" };
  }
}

// ─── Context-quality helpers ──────────────────────────────────────────

/**
 * Intent classifier — grapheme cluster count + word entropy.
 *
 * Replaces the v1 five-character heuristic with a CJK-safe
 * multi-signal detector. All three signals must pass for intent to be
 * considered present; failure of any returns true (missing intent),
 * preventing LLM downgrade of rule-based MEDIUM/HIGH verdicts.
 *
 *   1. Grapheme count >= 15 (via Intl.Segmenter — CJK characters each
 *      count as one grapheme, avoiding the v1 false-positive where a
 *      5-char Korean utterance counted as absent intent).
 *
 *   2. Unique word count >= 3 (whitespace-split, deduplicated, min word
 *      length 2 chars — filters punctuation-only tokens and stop words).
 *
 *   3. Character diversity ratio: unique chars / total chars >= 0.25
 *      (entropy proxy — catches repeated-character spam like "aaaaaa"
 *      that passes grapheme and word count but carries no intent signal).
 *
 * Conservative bias: any signal failure returns true (missing intent).
 * O(n) in message length; no LLM call.
 *
 * Resolves Korean CJK false-positive finding: short Korean messages were
 * previously misclassified as absent intent by the v1 character-count heuristic.
 */
export function isContextMissingIntent(input: ToolInvocationContext): boolean {
  const msg = input.conversationContext?.recentUserMessage?.trim() ?? "";
  if (msg.length === 0) return true;

  // Signal 1: grapheme cluster count (CJK-safe)
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(msg)).length;
  if (graphemes < 15) return true;

  // Signal 2: unique word count (whitespace-split, min length 2)
  const words = new Set(
    msg.toLowerCase().split(/\s+/).filter((w) => w.length >= 2),
  );
  if (words.size < 3) return true;

  // Signal 3: character diversity ratio (entropy proxy)
  const uniqueChars = new Set(msg).size;
  const diversityRatio = uniqueChars / msg.length;
  if (diversityRatio < 0.25) return true;

  return false;
}

// ─── RuleBasedRiskClassifier ─────────────────────────────────────────
//
// 36-combination heuristic. Each rule is a pure function that returns
// either a verdict or `null` to fall through. Order matters: more
// specific verbs/domains run first; the catch-all default is MEDIUM
// (fail-safe — never downgrade an unknown shape to LOW).

/**
 * Destructive shell verbs (HIGH). Word-boundary match so `rmdir` is
 * caught and `farmer` is not.
 */
const DESTRUCTIVE_SHELL_RE = new RegExp([
  String.raw`\brm\s+-r`,
  String.raw`\brm\s+-f`,
  String.raw`\brm\s+-rf`,
  String.raw`\bsudo\b`,
  String.raw`\bcurl[^|]*\|\s*sh`,
  String.raw`\bwget[^|]*\|\s*sh`,
  String.raw`\bdd\s+if=`,
  String.raw`\bmkfs\b`,
  String.raw`\bchmod\s+777`,
  String.raw`\bRemove-Item\b[^\n\r;|&]*\s-(?:Recurse|Force)\b`,
  String.raw`\brmdir\b[^\n\r;|&]*/s\b`,
  String.raw`\brd\b[^\n\r;|&]*/s\b`,
  String.raw`\bdel\b[^\n\r;|&]*/s\b`,
].join("|"), "i");

/**
 * Reversible shell verbs (LOW). Read-only or trivially undoable.
 */
const REVERSIBLE_SHELL_RE =
  /^\s*(echo|touch|ls|cat|pwd|whoami|date|env|true|false)\b/i;

/**
 * Hosts the host considers trusted by virtue of being LVIS-owned or
 * canonical model providers. `network → trusted-host` collapses to LOW.
 *
 * Exact-match set for well-known fixed hostnames. For hosts that appear
 * as subdomains (e.g. Azure AI Foundry project endpoints), use the
 * suffix list below.
 */
const TRUSTED_NETWORK_HOSTS: ReadonlySet<string> = new Set([
  "lvisai.xyz",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "models.github.ai",
]);

/**
 * Trusted hostname suffixes — any hostname that ends with one of these
 * patterns (and the suffix is preceded by a `.` or IS the full hostname)
 * is considered trusted. Used for Azure endpoints whose project subdomain
 * varies per user (`<project>.services.ai.azure.com`,
 * `<resource>.openai.azure.com`, etc.).
 *
 * Subdomain takeover analysis: both suffixes are rooted at `.azure.com`,
 * which Microsoft controls. A dangling-CNAME attack would require an
 * attacker to claim the exact Azure resource in the user's subscription —
 * not feasible without the user's subscription credentials. See also
 * {@link validateFoundryEndpoint} in provider-adapters.ts.
 */
export const TRUSTED_NETWORK_HOST_SUFFIXES: readonly string[] = [
  ".services.ai.azure.com",
  ".openai.azure.com",
];

/**
 * Returns true when `host` is in {@link TRUSTED_NETWORK_HOSTS} (exact) or
 * ends with one of {@link TRUSTED_NETWORK_HOST_SUFFIXES} (suffix).
 */
function isTrustedNetworkHost(host: string): boolean {
  if (TRUSTED_NETWORK_HOSTS.has(host)) return true;
  for (const suffix of TRUSTED_NETWORK_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

/** Localhost / loopback variants. */
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

function extractNetworkHost(input: Record<string, unknown>): string | null {
  return extractNetworkTarget(input)?.host ?? null;
}

function extractNetworkMethod(input: Record<string, unknown>): string | null {
  for (const key of ["method", "httpMethod", "verb"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().toUpperCase();
    }
  }
  return null;
}

function hasMeaningfulPayload(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function hasNetworkPayload(input: Record<string, unknown>): boolean {
  for (const key of [
    "payload",
    "body",
    "data",
    "content",
    "message",
    "text",
    "summary",
    "file",
    "files",
    "attachment",
    "attachments",
  ]) {
    if (hasMeaningfulPayload(input[key])) return true;
  }
  return false;
}

const NETWORK_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set([
  ...NETWORK_TARGET_FIELDS,
  "method",
  "httpMethod",
  "verb",
]);

function hasNonDescriptorGraphInput(input: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(input)) {
    if (NETWORK_DESCRIPTOR_FIELDS.has(key)) continue;
    if (hasMeaningfulPayload(value)) return true;
  }
  return false;
}

function isGraphMetadataRead(input: Record<string, unknown>, target: NetworkTarget): boolean {
  const method = extractNetworkMethod(input) ?? "GET";
  if (method !== "GET" || hasNetworkPayload(input) || hasNonDescriptorGraphInput(input)) return false;
  const normalizedPath = target.path.replace(/\/+$/, "");
  return normalizedPath === "/v1.0/me" || normalizedPath === "/beta/me" || normalizedPath === "/me";
}

/**
 * Extract declared paths and canonicalize each one for sandbox/allowed-dir
 * matching.
 *
 * Step 1 — argument → absolute path via
 * {@link resolveToolPathForPermission}, the SAME resolver the enforcer uses in
 * `extractTargetFilePaths`. Not cosmetic: a bare `path.resolve` leaves a
 * leading `~` as a literal path segment and resolves relative arguments
 * against `process.cwd()` rather than the invocation cwd, so the reviewer used
 * to compute its verdict about a path Layer 1 never checks.
 *
 * Step 2 — canonicalize for matching:
 * `..` segments / NFD unicode forms / trailing spaces / mixed-case
 * (darwin/win32) / duplicate slashes are all collapsed via
 * {@link canonicalizePathForMatch} before any prefix compare. Without
 * canonicalization an attacker can pass
 * `~/.lvis/plugins/foo/../../sessions/sensitive.jsonl` and bypass the
 * sandbox-write check via plain `startsWith`.
 *
 * The allowed-dir list passed by the caller is also canonicalized at the
 * caller's layer (boot-time / settings load), so both sides of the prefix
 * compare have the same shape.
 *
 * The divergence this replaced is pinned in the opposite direction now: see
 * `__tests__/declared-path-resolution-divergence.test.ts` (both normalizers
 * agree) and `permissions/__tests__/reviewer-path-resolution-alignment.test.ts`
 * (which verdicts moved, and in which direction).
 */
function extractDeclaredPaths(ctx: ToolInvocationContext): string[] {
  const paths: string[] = [];
  for (const field of ctx.pathFields) {
    const candidate = getDottedFieldValue(ctx.finalInput, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        paths.push(
          caseFoldForMatch(
            canonicalizePathForMatch(
              resolveToolPathForPermission(value, ctx.executionCwd),
            ),
          ),
        );
      } catch {
        // Mirror the enforcer: tool schema validation owns argument-type
        // failures. An unresolvable path contributes nothing, and an empty
        // path list falls through to the "write path not declared" HIGH rule —
        // the safe direction.
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Dir-containment check: does `path` start with any allowed dir?
 *
 * Delegates to {@link isPathAllowed}, the ENFORCED Layer-1 predicate
 * (`PermissionManager.checkPathScope`). The reviewer must answer
 * "is this inside the authorized scope" exactly as enforcement does, or a
 * verdict is computed about a containment the enforcer disagrees with.
 *
 * The inputs MUST already be canonicalized
 * ({@link canonicalizePathForMatch}). Layer 1 canonicalizes allowed dirs
 * at settings load; {@link extractDeclaredPaths} canonicalizes path-field
 * values. The compare is therefore a plain prefix compare, and the
 * canonical-form invariant is what closes the path-traversal vector.
 */
function isInsideAllowed(path: string, allowed: readonly string[]): boolean {
  return isPathAllowed(path, { directories: allowed });
}

/**
 * "Deep" = path is inside an allowed dir but ≥3 levels below the
 * matched root (heuristic for "more dangerous than a leaf write").
 * Containment per entry is {@link isInsideAllowed}; only the depth
 * measurement is local. First matching root wins (unchanged).
 */
function isDeepInsideAllowed(path: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    if (isPathAllowed(path, { directories: [a] })) {
      const tail = path.slice(a.length).replace(/^\/+/, "");
      const segs = tail.split("/").filter((s) => s.length > 0);
      return segs.length >= 3;
    }
  }
  return false;
}

const RULES: Array<(ctx: ToolInvocationContext) => RiskVerdict | null> = [
  // ── shell rules (3) ─────────────────────────────────────
  (ctx) => {
    if (ctx.category !== "shell") return null;
    // Every command-bearing field, not just the first populated one — a
    // destructive `script` next to a benign `command` must still read high.
    const cmds = extractShellCommands(ctx.finalInput);
    if (cmds.some((cmd) => DESTRUCTIVE_SHELL_RE.test(cmd))) {
      return { level: "high", reason: "shell destructive verb" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "shell") return null;
    const cmds = extractShellCommands(ctx.finalInput);
    if (cmds.length > 0 && cmds.every((cmd) => REVERSIBLE_SHELL_RE.test(cmd))) {
      return { level: "low", reason: "shell reversible verb" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "shell") return null;
    return { level: "medium", reason: "shell unclassified" };
  },

  // ── network rules ──────────────────────────────────────
  (ctx) => {
    if (ctx.category !== "network") return null;
    const target = extractNetworkTarget(ctx.finalInput);
    if (target?.host === "graph.microsoft.com") {
      if (isGraphMetadataRead(ctx.finalInput, target)) {
        return { level: "low", reason: "network graph metadata read" };
      }
      return { level: "medium", reason: "network graph data operation" };
    }
    const host = target?.host ?? null;
    if (host && isTrustedNetworkHost(host)) {
      return { level: "low", reason: `network trusted host (${host})` };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "network") return null;
    const host = extractNetworkHost(ctx.finalInput);
    if (host && LOCALHOST_HOSTS.has(host)) {
      return { level: "medium", reason: `network localhost (${host})` };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "network") return null;
    return { level: "high", reason: "network untrusted host" };
  },

  // ── write rules (4) ────────────────────────────────────
  //
  // Issue #664 P1 — Sandbox-write auto-LOW (#885 v6 — HOST-DERIVED).
  //
  // When the tool is plugin-owned (host-computed `ownerPluginSandboxRoot` set)
  // AND every resolved path is inside that sandbox root, the write collapses to
  // LOW. #885 v6 (Q4): the old manifest `writesToOwnSandbox` gate is GONE — the
  // containment proof below IS the signal (the self-claim added no security
  // value; a lying `true` never bypassed this proof). The failure direction is
  // safe: a path escaping the root falls through to the existing HIGH rules.
  //
  // Without this rule a plugin like ms-graph that writes its MSAL token cache
  // to `~/.lvis/plugins/lvis-plugin-ms-graph/data/...` gets caught by the "write
  // path not declared" or "write outside allowed dirs" HIGH rules — the host's
  // `allowedDirectories` does not include plugin sandboxes by design (plugin
  // data isolation, §5 file-based memory). The auto-LOW rule lets plugins
  // touch their own sandbox without round-tripping the user.
  //
  // If `pathFields` are declared but resolve to nothing (manifest mistake),
  // we do NOT auto-LOW — falls through to the standard "write path not
  // declared" HIGH so manifest bugs do not silently downgrade verdicts.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    const paths = extractDeclaredPaths(ctx);
    if (paths.length === 0) return null; // declared-but-empty → fall through to HIGH
    // Canonicalize the sandbox root on the producer's behalf so the
    // path-traversal defense holds even if a caller forgets to pre-
    // canonicalize. Both sides of the prefix compare are now bit-
    // identical canonical strings.
    const canonicalRoot = caseFoldForMatch(canonicalizePathForMatch(ctx.ownerPluginSandboxRoot));
    const allInside = paths.every((p) =>
      isInsideAllowed(p, [canonicalRoot]),
    );
    if (!allInside) return null;
    return { level: "low", reason: "write inside owner plugin sandbox" };
  },
  // `skill_load` declares `write` because a skill body mutates the assistant's
  // future behavior, not the filesystem. It therefore has NO path field by
  // construction and would permanently trip the "write path not declared" HIGH
  // rule below — and HIGH is un-persistable, so the user is re-asked on every
  // single load. That duplicate gate is also redundant: skill_load carries its
  // own durable control in `tools/skill-load.ts`, an approval record hash-bound
  // to the exact body + bundle, which prompts once per distinct body and
  // re-prompts the moment the body changes. That gate is strictly STRONGER than
  // a level here (content-bound, not tool-bound), so the reviewer defers to it
  // rather than stacking a second, weaker prompt in front of it. Scoped to the
  // builtin tool by name: a plugin/MCP tool cannot reach this rule.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (ctx.source !== "builtin" || ctx.toolName !== "skill_load") return null;
    return { level: "low", reason: "skill load governed by body-hash approval" };
  },
  // A plugin-owned write-category tool with NO resolvable target path would
  // fall to the "write path not declared" HIGH below. But when this CALL's
  // execution substrate is genuinely OS-confined — the owner plugin's ASRT
  // child or wrapped worker, whose filesystem write set is the host-derived
  // envelope rooted at the owner's own sandbox — the kernel already bounds
  // every filesystem side-effect to the owner's jail. That is the SAME
  // containment fact the declared-path LOW above proves lexically, held by a
  // stronger authority, so even a manifest mistake cannot widen anything.
  // Keyed on the host-resolved per-call capability (produced by
  // resolveReviewerSandboxCapability from the no-leak wrapped registries) —
  // never on a manifest claim; an in-process plugin tool resolves to `none`
  // and keeps the HIGH below.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    if (extractDeclaredPaths(ctx).length > 0) return null; // declared paths take the lexical rules
    if (!sandboxRelaxesCategory(ctx.sandboxCapability, "write")) return null;
    return { level: "low", reason: "no declared write path; OS-confined to owner plugin sandbox" };
  },
  // The same call one step weaker: a plugin-owned tool with no declared target
  // that is NOT OS-confined. HIGH is the wrong answer here, and the reason is
  // what `category` means for a plugin tool.
  //
  // `mcpToolToPluginTool` sets `category = "write"` on EVERY plugin tool
  // unconditionally — it is a default-strict placeholder, not a classification
  // (#885: the host does not trust a plugin's self-declared category, so it
  // reads none). The rule below then treats that placeholder as an assertion
  // that a write happens, and combines it with a SECOND absence of knowledge
  // ("no target declared") to produce the MAXIMUM verdict. Two things we do not
  // know are multiplied into certainty of danger.
  //
  // What makes that concretely harmful is that HIGH is un-persistable, so the
  // user is re-asked on every single invocation of a tool that may well be a
  // pure query. `skill_load` above carries the identical argument in its own
  // comment; the difference is that skill_load could name a stronger control to
  // defer to, and here there is none — so this lands on MEDIUM rather than LOW.
  // MEDIUM is the honest encoding of "unknown": still deny-by-default, still
  // prompts, but the user's decision can be durable instead of being asked for
  // forever until they stop reading it.
  //
  // Scope is narrow by construction. A call that names a target does not reach
  // here — `extractDeclaredPaths` non-empty falls through to the lexical rules
  // below, so a multiplexed tool (list vs add) keeps its write verdict on the
  // arm that actually names a folder. And `ownerPluginSandboxRoot` is host-set
  // for plugin-owned tools only, so builtin and MCP tools are untouched.
  (ctx) => {
    if (ctx.category !== "write") return null;
    if (ctx.source !== "plugin") return null;
    if (!ctx.ownerPluginSandboxRoot) return null; // host-set; plugin-owned tools only
    // Declared-but-unresolved is NOT the same as never declared. The auto-LOW
    // rule above states the promise this would otherwise break: a manifest that
    // declares `pathFields` and resolves to nothing "falls through to the
    // standard HIGH so manifest bugs do not silently downgrade verdicts". An
    // empty result also covers a non-string value, an empty string, and a
    // canonicalization throw — all of them reachable from the CALL's arguments,
    // which the plugin controls. Keying on the DECLARATION instead means an
    // argument cannot move a tool off the HIGH its manifest earned.
    if (ctx.pathFields.length > 0) return null;
    if (extractDeclaredPaths(ctx).length > 0) return null;
    return {
      level: "medium",
      requiresExplicitApproval: true,
      reason: "no declared write path; plugin category is a strict default, not an observation",
    };
  },
  (ctx) => {
    if (ctx.category !== "write") return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.length === 0) {
      return { level: "high", reason: "write path not declared" };
    }
    if (paths.some((p) => !isInsideAllowed(p, ctx.allowedDirectories))) {
      return { level: "high", reason: "write outside allowed dirs" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "write") return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.some((p) => isDeepInsideAllowed(p, ctx.allowedDirectories))) {
      return { level: "medium", reason: "write deep inside allowed" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "write") return null;
    return { level: "low", reason: "write at allowed-dir leaf" };
  },

  // ── meta rules (2) ──────────────────────────────────────
  //
  // `agent_spawn` first. Before this rule the `meta` category matched NOTHING
  // and fell through to the fail-safe MEDIUM at the bottom of `classify()` —
  // a rule GAP, not a judgement. `resolveReviewerDecision` asks on MEDIUM
  // unless the threshold is itself `medium`, so every spawn raised a modal,
  // which serialized parallel spawns behind one-at-a-time approvals and
  // defeated `parallelSafe` batching entirely.
  //
  // Spawning confers NO new authority: the child's every effectful tool call is
  // re-checked by this same PermissionManager, under the parent's scoped
  // registry minus the fork-bomb blocklist. The dangerous act is what the child
  // DOES, and that is gated where it happens.
  //
  // Deliberately name-scoped rather than category-scoped: a blanket LOW for
  // `meta` would also cover every other builtin meta tool, present and future.
  // Every other meta tool keeps its existing fail-safe MEDIUM.
  (ctx) => {
    if (ctx.category !== "meta") return null;
    if (ctx.source !== "builtin" || ctx.toolName !== "agent_spawn") return null;
    return { level: "low", reason: "agent spawn (child tool effects gated separately)" };
  },
  // `agent_status` used to need a third rule here, name-scoped to `meta`. It no
  // longer does: it declares `read`, which is what it is, so the read rules
  // below grade it — and every OTHER gate that keys on the category grades it
  // the same way, which a rule sitting only in this chain could never make true.

  // ── read rules (2) — read shouldn't usually reach reviewer ──
  (ctx) => {
    if (ctx.category !== "read") return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.some((p) => !isInsideAllowed(p, ctx.allowedDirectories))) {
      return { level: "high", reason: "read outside allowed dirs" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "read") return null;
    return { level: "low", reason: "read inside allowed dirs" };
  },
];

export class RuleBasedRiskClassifier implements RiskClassifier {
  classify(input: ToolInvocationContext): RiskVerdict {
    for (const rule of RULES) {
      const v = rule(input);
      if (v) return v;
    }
    // Default fail-safe: MEDIUM (never silently LOW for an unknown shape).
    return { level: "medium", reason: "no rule matched (fail-safe medium)" };
  }
}

// ─── LlmRiskClassifier ───────────────────────────────────────────────

/**
 * Minimal LLM provider shim — the reviewer needs only a one-shot
 * "complete prompt → JSON string + usage" call. The host's full
 * VercelUnifiedProvider exposes `streamTurn`; this interface is the
 * narrow surface a provider adapter exposes for synchronous
 * single-shot risk classification.
 */
export interface LlmCompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LlmReviewerProvider {
  complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult>;
}

/**
 * Render a JSON object as a prompt-safe string with all secrets DLP-masked.
 * Per-value: stringify, then run through `maskSensitiveData`. Truncate
 * each value at 200 chars to keep prompts compact.
 */
export function dlpRedactInputForPrompt(
  finalInput: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(finalInput)) {
    const raw = typeof v === "string" ? v : JSON.stringify(v ?? null);
    const { masked } = maskSensitiveData(raw);
    out[k] = masked.length > 200 ? masked.slice(0, 200) + "…" : masked;
  }
  return out;
}

function buildUserPrompt(input: ToolInvocationContext): string {
  const redacted = dlpRedactInputForPrompt(input.finalInput);
  const recentUserMessage = input.conversationContext?.recentUserMessage;
  const redactedContext =
    typeof recentUserMessage === "string" && recentUserMessage.trim().length > 0
      ? maskSensitiveData(recentUserMessage).masked.slice(0, 500)
      : undefined;
  return (
    `<UNTRUSTED_INPUT>\n` +
    `tool: ${input.toolName}\n` +
    `source: ${input.source}\n` +
    `category: ${input.category}\n` +
    `pathFields: ${JSON.stringify(input.pathFields)}\n` +
    `trustOrigin: ${input.trustOrigin}\n` +
    `input (DLP-redacted): ${JSON.stringify(redacted)}\n` +
    `conversationContext (DLP-redacted): ${JSON.stringify(redactedContext ?? null)}\n` +
    `allowedDirectories: ${JSON.stringify(input.allowedDirectories.slice(0, 8))}\n` +
    `sensitivePathsAdjacent: ${JSON.stringify(input.sensitivePathsAdjacent.slice(0, 8))}\n` +
    `${formatSandboxCapabilityForPrompt(input.sandboxCapability)}\n` +
    `</UNTRUSTED_INPUT>`
  );
}

function tryParseVerdict(text: string): RiskVerdict | null {
  // Find the first balanced `{...}` — the SYSTEM prompt asks for "only JSON",
  // but real LLMs occasionally wrap with a code-fence; tolerate that.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const level = obj.level;
  const reason = obj.reason;
  if (
    (level !== "low" && level !== "medium" && level !== "high") ||
    typeof reason !== "string"
  ) {
    return null;
  }
  const trimmed = reason.length > 80 ? reason.slice(0, 80) : reason;
  return { level, reason: trimmed };
}

export type FallbackOnError = "deny" | "rule";

/**
 * Retry policy for the LLM provider call inside `classify()`. Transient
 * failures (network blip, rate limit, 5xx) are retried with exponential
 * back-off + jitter; deterministic failures (parse error, abort, 4xx
 * client errors) are NOT retried. Defaults are chosen so the user-visible
 * worst-case latency (~1s for 3 attempts at 250ms / 500ms with jitter)
 * stays well under the approval dock's perceptual threshold while still
 * absorbing a single transient flap.
 *
 * Issue: #865 — before this wiring, every provider failure went straight
 * to `fallbackOnError`, so users saw spurious "denied" verdicts on any
 * network glitch even when a retry would have succeeded.
 */
export interface LlmReviewerRetryConfig {
  /** Total attempts including the first try. 1 = no retry. Clamped >= 1. */
  maxAttempts: number;
  /** Initial delay before the FIRST retry (ms). Doubles each attempt. */
  baseDelayMs: number;
  /** Jitter % applied to each delay (0-100). 25 → ±25% multiplicative. */
  jitterPct: number;
}

export const DEFAULT_REVIEWER_RETRY: LlmReviewerRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  jitterPct: 25,
};

export interface LlmRiskClassifierTelemetry {
  onCall?(stats: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    parseFailed: boolean;
    /** Total LLM provider invocations including retries. 1 = success on first try. */
    attempts?: number;
  }): void;
}

/**
 * Sleep that resolves early when the abort signal fires. Returns whether
 * the sleep completed normally (true) or was aborted (false). Used so a
 * user-cancel during a retry back-off does not block the cancel UX behind
 * the remaining sleep window.
 */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return true;
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      // Microtask-race guard: the abort event may fire
      // AFTER setTimeout queued this callback but BEFORE it executed. In
      // that window `clearTimeout` is a no-op and `onAbort.resolve(false)`
      // races our `resolve(true)`. Re-check the signal here so the sleep
      // honestly reports completion vs abort.
      resolve(!signal?.aborted);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Classify a provider error as transient (worth retrying) vs terminal.
 * Terminal: abort (user cancel), 4xx-client (other than rate limit), parse
 * issues (those are handled separately, never reach this). Transient: 5xx,
 * 429 rate limit, network/timeout flap, AggregateError, unknown error
 * shapes (conservative: prefer to retry rather than fail fast when we don't
 * know — bounded by maxAttempts).
 */
function isTransientReviewerError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    if (msg.includes("aborted")) return false;
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate-limit")) return true;
    if (/\b5\d{2}\b/.test(msg)) return true; // 5xx
    if (msg.includes("etimedout") || msg.includes("econnreset") || msg.includes("enotfound") ||
        msg.includes("econnrefused") || msg.includes("network") || msg.includes("fetch failed") ||
        msg.includes("timeout") || msg.includes("socket")) {
      return true;
    }
    // Explicit 4xx (not 429) → terminal
    if (/\b4\d{2}\b/.test(msg)) return false;
  }
  // Conservative default: retry. maxAttempts bounds the blast.
  return true;
}

/**
 * Builtin tools whose risk verdict is fully determined by host structure,
 * each mapped to the category its own LOW rule is scoped to.
 *
 * Membership bar is high: a tool belongs here only when its safety argument
 * rests on an invariant the HOST enforces elsewhere, making the LLM reviewer's
 * opinion not merely redundant but unanswerable — the invariant is not part of
 * its prompt. Everything else keeps the max(rule, llm) path.
 *
 *   - `agent_spawn` (meta) — the child's every effectful tool call re-enters
 *     PermissionManager, so spawning confers no new authority.
 *   - `agent_status` (read) — reads host-owned run bookkeeping scoped by the
 *     host-supplied origin session id; no argument reaches an effect.
 *   - `agent_list` (read) — returns agent profile definitions plus this
 *     conversation's own persisted sub-agent entries; it takes NO input at all
 *     (`properties: {}`), so there is nothing for a model to weigh.
 *
 * Both readers kept being rated HIGH by the reviewer LLM on the same
 * "sub-agents can do anything" reasoning it applied to `agent_spawn`, and
 * `max(rule, llm)` let that guess override the host's LOW — turning a status
 * poll after a restart into an approval modal.
 *
 * The value is the EXPECTED category rather than a single hard-coded one: the
 * readers declare `read` and `agent_spawn` declares `meta`, and pinning each
 * tool to its own declared category preserves the co-scoping invariant below
 * per-tool. A tool that drifts off its declared category loses the bypass and
 * takes the full composed path, which is the safe direction.
 */
const HOST_DETERMINED_RISK_TOOLS: ReadonlyMap<string, ToolCategory> = new Map([
  ["agent_spawn", "meta"],
  ["agent_status", "read"],
  ["agent_list", "read"],
]);

function isHostDeterminedRiskTool(input: ToolInvocationContext): boolean {
  // Co-scoped with the rule that justifies each bypass (category included):
  // those LOW rules key on (category, source, toolName), and keying the bypass
  // on fewer axes would let a category drift hand the final verdict to a
  // DIFFERENT rule with no LLM cross-check.
  if (input.source !== "builtin") return false;
  return HOST_DETERMINED_RISK_TOOLS.get(input.toolName) === input.category;
}

export class LlmRiskClassifier implements RiskClassifier {
  private readonly rule = new RuleBasedRiskClassifier();

  constructor(
    private readonly provider: LlmReviewerProvider,
    private readonly model: string,
    private readonly fallbackOnError: FallbackOnError = "deny",
    private readonly telemetry: LlmRiskClassifierTelemetry = {},
    private readonly retry: LlmReviewerRetryConfig = DEFAULT_REVIEWER_RETRY,
  ) {}

  /**
   * Run `provider.complete()` with bounded retry on transient errors.
   * Returns the attempt count on success so telemetry can record it. Throws
   * the LAST error on exhaustion or on the first terminal error. Honors
   * `abortSignal` at every sleep boundary so user-cancel is not blocked.
   */
  private async runProviderWithRetry(
    userPrompt: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ completion: Awaited<ReturnType<LlmReviewerProvider["complete"]>>; attempts: number }> {
    // Clamp config defensively: the caller may pass an
    // unvalidated config from settings or a future runtime knob —
    // `maxAttempts > 10` would risk retry storms, `jitterPct > 100` would
    // collapse to zero-delay retry through `Math.max(0, …)`, `jitterPct < 0`
    // would invert direction. Hard ceilings + floors prevent both.
    const maxAttempts = Math.max(1, Math.min(10, this.retry.maxAttempts));
    const jitterPct = Math.max(0, Math.min(100, this.retry.jitterPct));
    const baseDelayMs = Math.max(0, this.retry.baseDelayMs);
    let lastErr: unknown = new Error("unreachable");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Note: deliberately do NOT short-circuit on `abortSignal.aborted`
      // before calling complete(). The provider is the canonical owner of
      // abort handling and tests rely on the provider seeing the signal
      // even when it was already-aborted at entry — preserves the
      // pre-#865 contract.
      try {
        const completion = await this.provider.complete({
          model: this.model,
          systemPrompt: PERMISSION_REVIEWER_SYSTEM_PROMPT,
          userPrompt,
          abortSignal,
        });
        return { completion, attempts: attempt };
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts) break;
        if (!isTransientReviewerError(err)) break;
        // Exponential back-off with multiplicative jitter (±jitterPct).
        // Only the SLEEP between retries is signal-aware — if the user
        // cancels during back-off we honour it immediately rather than
        // making them wait out the remaining window.
        const base = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = 1 + ((Math.random() * 2 - 1) * jitterPct) / 100;
        const delay = Math.max(0, Math.round(base * jitter));
        const completed = await abortableSleep(delay, abortSignal);
        if (!completed) {
          throw new Error("aborted");
        }
      }
    }
    throw lastErr;
  }

  // MEDIUM: accepts optional abortSignal so callers (dispatchReviewer,
  // interactive approval flow) can cancel an in-flight LLM call when the
  // user cancels the operation. The second parameter is not part of the
  // RiskClassifier interface (which is intentionally signal-agnostic) but
  // is called directly by callers that have a signal available.
  async classify(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<RiskVerdict> {
    const trace = await this.classifyWithTrace(input, opts);
    return trace.finalVerdict;
  }

  // Audit callers need the raw rule + LLM verdicts separately from the
  // composed final verdict. The public RiskClassifier interface remains the
  // final-verdict-only surface so non-LLM classifiers stay simple.
  async classifyWithTrace(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<LlmRiskClassificationTrace> {
    // Composition baseline — rule first, LLM cannot downgrade.
    const ruleVerdict = this.rule.classify(input);

    // Host-determined tools never consult the LLM: their risk is settled by
    // system structure, not by anything a model could weigh. For agent_spawn
    // the structural fact is that every effectful call the child makes
    // re-enters this same permission pipeline — a fact that is not in the
    // reviewer prompt, so asking the LLM poses a question it cannot answer;
    // it kept replying HIGH ("no sandbox isolation, file access") and the
    // max(rule, llm) composition let that guess override the host's LOW.
    // Name-scoped and builtin-only: a plugin/MCP tool that happens to share
    // the name still takes the full composed path.
    if (isHostDeterminedRiskTool(input)) {
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "host-determined" };
    }

    // Composition-pinned HIGH: the final verdict is maxVerdict(rule, llm) and
    // HIGH is the top of the scale, so once the RULE verdict is HIGH the
    // provider round-trip cannot change the outcome — the LLM can only raise
    // or tie (a tie merely swaps the reason text). It only adds seconds in
    // front of a modal the user is already going to see — and HIGH is
    // un-persistable, so that cost recurred on EVERY invocation of the same
    // tool. Skip the call. If composition ever gains a genuine downgrade
    // path, this early-return must be re-derived alongside it.
    if (
      ruleVerdict.level === "high" ||
      ruleVerdict.requiresExplicitApproval === true
    ) {
      // "host-determined" is the existing outcome for exactly this semantic:
      // the rule verdict is final by construction and the LLM was never
      // consulted (see ReviewerDispatchOutcome).
      //
      // `requiresExplicitApproval` joins HIGH here for two reasons. The call is
      // going to a person either way, so the round trip cannot change the
      // outcome — the same argument the paragraph above makes for HIGH. And
      // `maxVerdict` returns ONE of the two verdicts whole: an LLM verdict at
      // the SAME level wins the tie and would carry the flag away with it,
      // silently re-opening (b) and (c). Not asking is what keeps that from
      // being possible rather than merely unlikely.
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "host-determined" };
    }

    let llmVerdict: RiskVerdict;
    try {
      const userPrompt = buildUserPrompt(input);
      const { completion, attempts } = await this.runProviderWithRetry(
        userPrompt,
        opts?.abortSignal,
      );
      const parsed = tryParseVerdict(completion.text);
      this.telemetry.onCall?.({
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        costUsd: completion.costUsd,
        parseFailed: parsed === null,
        attempts,
      });
      if (parsed === null) {
        // Parse failure → fallbackOnError policy
        if (this.fallbackOnError === "deny") {
          const finalVerdict = { level: "high", reason: "llm parse failure — fallbackOnError=deny" } as const;
          return { ruleVerdict, llmVerdict: finalVerdict, finalVerdict, outcome: "malformed" };
        }
        return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome: "malformed" };
      }
      llmVerdict = parsed;
    } catch (err) {
      // Any provider error (after retry exhaustion or terminal-classified)
      // → fallbackOnError policy. Surface the worst-case attempt count to
      // telemetry so dashboards can distinguish first-try-failure from
      // retry-exhaustion; the exhaustion rate is the signal that matters
      // for provider reliability.
      this.telemetry.onCall?.({
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        parseFailed: true,
        attempts: Math.max(1, Math.min(10, this.retry.maxAttempts)),
      });
      if (this.fallbackOnError === "deny") {
        // DLP-mask the provider error message before embedding into the
        // verdict reason: provider errors sometimes
        // echo request body fragments back, which would otherwise land in
        // audit logs + UI without redaction.
        const rawMsg = err instanceof Error ? err.message ?? "error" : "error";
        const { masked } = maskSensitiveData(rawMsg);
        const msg = masked.slice(0, 60);
        const finalVerdict = { level: "high", reason: `llm error — fallback=deny (${msg})` } as const;
        const outcome = reviewerFailureOutcome(err);
        return { ruleVerdict, llmVerdict: finalVerdict, finalVerdict, outcome };
      }
      const outcome = reviewerFailureOutcome(err);
      return { ruleVerdict, llmVerdict: null, finalVerdict: ruleVerdict, outcome };
    }

    // Context-quality + per-category sandbox composition enforcement:
    // The sandbox relaxation is now per-CATEGORY — it applies only when the
    // capability's `confines` dimension that covers this call's category is
    // genuinely jailed (network risk ↔ confines.network; filesystem-bearing
    // write/shell/read/meta ↔ confines.filesystem). When the sandbox does NOT
    // relax this category, OR conversation context lacks explicit intent,
    // prevent the LLM from downgrading a rule-based MEDIUM/HIGH verdict to LOW.
    const sandboxRelaxes = sandboxRelaxesCategory(input.sandboxCapability, input.category);
    const weakContext = isContextMissingIntent(input);
    if (!sandboxRelaxes || weakContext) {
      if (LEVEL_RANK[llmVerdict.level] < LEVEL_RANK[ruleVerdict.level]) {
        // LLM attempted to downgrade — honour the rule verdict.
        return { ruleVerdict, llmVerdict, finalVerdict: ruleVerdict, outcome: "fresh" };
      }
    }

    return { ruleVerdict, llmVerdict, finalVerdict: maxVerdict(ruleVerdict, llmVerdict), outcome: "fresh" };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

export type ReviewerMode = "disabled" | "rule" | "llm" | "strict";

export interface ReviewerSettings {
  mode: ReviewerMode;
  /** Required when mode === "llm". */
  provider?: LlmReviewerProvider;
  /** Required when mode === "llm". Defaults to "gpt-4o-mini" per v2.1. */
  model?: string;
  /** Defaults to "deny" so reviewer provider failures fail closed. */
  fallbackOnError?: FallbackOnError;
  telemetry?: LlmRiskClassifierTelemetry;
}

/**
 * Boot-time factory. Throws when `mode === "llm"` is configured but the
 * provider is missing — atomic cutover, no fallback shim.
 */
export function createRiskClassifier(settings: ReviewerSettings): RiskClassifier {
  switch (settings.mode) {
    case "disabled":
      return new DisabledRiskClassifier();
    case "strict":
      return new StrictRiskClassifier();
    case "rule":
      return new RuleBasedRiskClassifier();
    case "llm": {
      if (!settings.provider) {
        throw new Error(
          `permissions.reviewer.mode = 'llm' but no provider configured. ` +
          `Set provider via createRiskClassifier({mode:'llm', provider, model}). ` +
          `(Permission policy P3 atomic cutover — no silent fallback to rule-based.)`,
        );
      }
      const fb = settings.fallbackOnError ?? "deny";
      if (fb !== "deny" && fb !== "rule") {
        throw new Error(
          `permissions.reviewer.fallbackOnError must be 'deny' or 'rule' — got '${fb}'. ` +
          `(Spec v2.1 §3 Layer 5: 'allow-and-audit' enum removed.)`,
        );
      }
      return new LlmRiskClassifier(
        settings.provider,
        settings.model ?? "gpt-4o-mini",
        fb,
        settings.telemetry,
      );
    }
    default: {
      const _exhaustive: never = settings.mode;
      void _exhaustive;
      throw new Error(`Unknown reviewer mode: ${String(settings.mode)}`);
    }
  }
}

// Internal exports for unit tests.
export const _internal = { buildUserPrompt, tryParseVerdict, RULES, PERMISSION_REVIEWER_SYSTEM_PROMPT, isContextMissingIntent };
