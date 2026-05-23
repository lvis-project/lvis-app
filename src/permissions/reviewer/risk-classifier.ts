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
 *     (LLM cannot downgrade — security M1).
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
import {
  formatSandboxCapabilityForPrompt,
  isWeakSandbox,
  type SandboxCapability,
} from "../sandbox-capability.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";

/** Verdict level — discrete enum. The reviewer lane never uses scalars. */
export type RiskLevel = "low" | "medium" | "high";

/** Verdict shape returned by every classifier. */
export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
}

/** Numeric ordering for `final = max(rule, llm)`. */
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Pick the higher-rank verdict. Ties prefer `b` (LLM) for reason text. */
export function maxVerdict(a: RiskVerdict, b: RiskVerdict): RiskVerdict {
  return LEVEL_RANK[b.level] >= LEVEL_RANK[a.level] ? b : a;
}

/**
 * Per-invocation context passed into a classifier. `finalInput` MUST
 * already be DLP-redacted by the caller for non-LLM paths; the LLM
 * classifier additionally re-masks before formatting into the prompt
 * so the same secret never reaches the provider even if the upstream
 * forgot.
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
  allowedDirectories: string[];
  /** Adjacent sensitive entries (e.g. `.env`, `.git`) detected near the path. */
  sensitivePathsAdjacent: string[];
  /**
   * OS-level execution sandbox capability — the reviewer SOT for issue
   * #691. Constructed by {@link detectSandboxCapability} at the dispatch
   * site (single producer) and threaded here so the LLM prompt sees the
   * same value used by the reviewer. The current audit schema records the
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
   * Issue #664 P1 — sandbox-write self-attestation.
   *
   * `ownerPluginSandboxRoot` is the absolute directory path the owning
   * plugin (or builtin tool) is permitted to write inside without
   * triggering reviewer escalation. For plugin tools this is
   * `~/.lvis/plugins/<ownerPluginId>/`, computed by the plugin runtime at
   * tool-invocation time. For builtin tools or where the contract does
   * not declare a sandbox, leave undefined and the normal write rules
   * apply.
   *
   * `writesToOwnSandbox` is the manifest/SDK-declared intent flag: the
   * tool promises that every value resolved through `pathFields` will
   * stay inside `ownerPluginSandboxRoot`. The classifier still verifies
   * the claim at invocation time (sound by construction) — a tool that
   * declares the flag but emits a path outside its own sandbox falls
   * back to the normal write rules.
   *
   * Both fields must be present to engage the auto-LOW rule. The owner
   * sandbox path participates in the verdict-cache scope so a future
   * sandbox move invalidates stale verdicts.
   */
  writesToOwnSandbox?: boolean;
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
 * guards, explicit approval modal) is unaffected.
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

function extractShellCommand(input: Record<string, unknown>): string | null {
  // Bash tool family — common field names.
  const candidates = ["command", "cmd", "script", "shellCommand"];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

interface NetworkTarget {
  host: string;
  path: string;
}

function extractNetworkTarget(input: Record<string, unknown>): NetworkTarget | null {
  const candidates = ["url", "endpoint", "host", "uri"];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v !== "string" || v.length === 0) continue;
    try {
      const u = new URL(v);
      return { host: u.hostname.toLowerCase(), path: u.pathname };
    } catch {
      // Not a URL — try direct host
      if (/^[a-zA-Z0-9.-]+$/.test(v)) return { host: v.toLowerCase(), path: "" };
    }
  }
  return null;
}

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
  "url",
  "endpoint",
  "host",
  "uri",
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

function getDottedFieldValue(input: Record<string, unknown>, field: string): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Extract declared paths and canonicalize each one for sandbox/allowed-dir
 * matching. Security MAJOR-3 (cluster review): `..` segments / NFD unicode
 * forms / trailing spaces / mixed-case (darwin/win32) / duplicate slashes
 * are all collapsed via {@link canonicalizePathForMatch} before any
 * prefix compare. Without canonicalization an attacker can pass
 * `~/.lvis/plugins/foo/../../sessions/sensitive.jsonl` and bypass the
 * sandbox-write check via plain `startsWith`.
 *
 * The allowed-dir list passed by the caller is also canonicalized at the
 * caller's layer (boot-time / settings load), so both sides of the prefix
 * compare have the same shape.
 */
function extractDeclaredPaths(ctx: ToolInvocationContext): string[] {
  const paths: string[] = [];
  for (const field of ctx.pathFields) {
    const candidate = getDottedFieldValue(ctx.finalInput, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) {
        paths.push(canonicalizePathForMatch(value));
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Dir-containment check: does `path` start with any allowed dir?
 *
 * Security MAJOR-3 — the inputs MUST already be canonicalized
 * ({@link canonicalizePathForMatch}). Layer 1 canonicalizes allowed dirs
 * at settings load; {@link extractDeclaredPaths} canonicalizes path-field
 * values. This function therefore performs a plain prefix compare, but
 * the canonical-form invariant is what closes the path-traversal vector.
 */
function isInsideAllowed(path: string, allowed: string[]): boolean {
  for (const a of allowed) {
    if (path === a || path.startsWith(a + "/")) return true;
  }
  return false;
}

/**
 * "Deep" = path is inside an allowed dir but ≥3 levels below the
 * matched root (heuristic for "more dangerous than a leaf write").
 * Same canonical-form invariant as {@link isInsideAllowed}.
 */
function isDeepInsideAllowed(path: string, allowed: string[]): boolean {
  for (const a of allowed) {
    if (path === a || path.startsWith(a + "/")) {
      const tail = path.slice(a.length).replace(/^\/+/, "");
      const segs = tail.split("/").filter((s) => s.length > 0);
      if (segs.length >= 3) return true;
      return false;
    }
  }
  return false;
}

const RULES: Array<(ctx: ToolInvocationContext) => RiskVerdict | null> = [
  // ── shell rules (3) ─────────────────────────────────────
  (ctx) => {
    if (ctx.category !== "shell") return null;
    const cmd = extractShellCommand(ctx.finalInput);
    if (cmd && DESTRUCTIVE_SHELL_RE.test(cmd)) {
      return { level: "high", reason: "shell destructive verb" };
    }
    return null;
  },
  (ctx) => {
    if (ctx.category !== "shell") return null;
    const cmd = extractShellCommand(ctx.finalInput);
    if (cmd && REVERSIBLE_SHELL_RE.test(cmd)) {
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
  // Issue #664 P1 — Sandbox-write auto-LOW.
  //
  // When the tool's manifest declared `writesToOwnSandbox: true` AND every
  // resolved path is inside the owner plugin's sandbox root, the write
  // collapses to LOW. The runtime verifies the path containment claim — the
  // declaration alone is not sufficient (sound-by-construction).
  //
  // Without this rule a plugin like ms-graph that writes its MSAL token cache
  // to `~/.lvis/plugins/lvis-plugin-ms-graph/...` gets caught by the "write
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
    if (!ctx.writesToOwnSandbox) return null;
    if (!ctx.ownerPluginSandboxRoot) return null;
    const paths = extractDeclaredPaths(ctx);
    if (paths.length === 0) return null;
    // Canonicalize the sandbox root on the producer's behalf so the
    // path-traversal defense holds even if a caller forgets to pre-
    // canonicalize. Both sides of the prefix compare are now bit-
    // identical canonical strings (security MAJOR-3).
    const canonicalRoot = canonicalizePathForMatch(ctx.ownerPluginSandboxRoot);
    const allInside = paths.every((p) =>
      isInsideAllowed(p, [canonicalRoot]),
    );
    if (!allInside) return null;
    return { level: "low", reason: "write inside owner plugin sandbox" };
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
 * stays well under the approval modal's perceptual threshold while still
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
      // Microtask-race guard (critic R1 MAJOR-3): the abort event may fire
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
    // Clamp config defensively (critic R1 MAJOR-1): caller may pass an
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
    // Composition baseline (security M1) — rule first, LLM cannot downgrade.
    const ruleVerdict = this.rule.classify(input);

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
          return { level: "high", reason: "llm parse failure — fallbackOnError=deny" };
        }
        return ruleVerdict;
      }
      llmVerdict = parsed;
    } catch (err) {
      // Any provider error (after retry exhaustion or terminal-classified)
      // → fallbackOnError policy. Surface the worst-case attempt count to
      // telemetry (critic R1 MINOR-4) so dashboards can distinguish
      // first-try-failure from retry-exhaustion — the exhaustion rate is
      // the exact signal #865 reliability work cares about.
      this.telemetry.onCall?.({
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        parseFailed: true,
        attempts: Math.max(1, Math.min(10, this.retry.maxAttempts)),
      });
      if (this.fallbackOnError === "deny") {
        // DLP-mask the provider error message before embedding into the
        // verdict reason (security R1 MINOR-3): provider errors sometimes
        // echo request body fragments back, which would otherwise land in
        // audit logs + UI without redaction.
        const rawMsg = err instanceof Error ? err.message ?? "error" : "error";
        const { masked } = maskSensitiveData(rawMsg);
        const msg = masked.slice(0, 60);
        return { level: "high", reason: `llm error — fallback=deny (${msg})` };
      }
      return ruleVerdict;
    }

    // Context-quality + weak-sandbox composition enforcement:
    // When sandbox is weak (kind=none/partial or confidence=assumed) OR
    // conversation context lacks explicit intent, prevent the LLM from
    // downgrading a rule-based MEDIUM/HIGH verdict to LOW.
    const weakSandbox = isWeakSandbox(input.sandboxCapability);
    const weakContext = isContextMissingIntent(input);
    if (weakSandbox || weakContext) {
      if (LEVEL_RANK[llmVerdict.level] < LEVEL_RANK[ruleVerdict.level]) {
        // LLM attempted to downgrade — honour the rule verdict.
        return ruleVerdict;
      }
    }

    return maxVerdict(ruleVerdict, llmVerdict);
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
