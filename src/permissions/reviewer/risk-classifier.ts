/**
 * Permission policy Phase 3 — Layer 5 Reviewer Agent: RiskClassifier interface + impls.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions (default `provider="openai"`,
 * `model="gpt-4o-mini"`; `fallbackOnError ∈ {deny, rule}`; default fail-closed;
 * verdict
 * composition `final = max(rule, llm)`; DLP filter on classifier input).
 *
 * Three implementations selected by mode:
 *   - `disabled` → DisabledRiskClassifier — always HIGH (defer-all
 *     fail-safe so the headless lane queues every action).
 *   - `rule`     → RuleBasedRiskClassifier — deterministic 36-rule
 *     heuristic (4 categories × 3 dir-relations × 3 confidence levels).
 *   - `llm`      → LlmRiskClassifier — multi-vendor LLM call. Always
 *     runs RuleBased first; takes `max(ruleVerdict, llmVerdict)`
 *     (LLM cannot downgrade — security M1).
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
}

export interface RiskClassifier {
  classify(input: ToolInvocationContext): RiskVerdict | Promise<RiskVerdict>;
}

// ─── DisabledRiskClassifier ───────────────────────────────────────────

export class DisabledRiskClassifier implements RiskClassifier {
  classify(_: ToolInvocationContext): RiskVerdict {
    return { level: "high", reason: "reviewer disabled — defer all" };
  }
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
 */
const TRUSTED_NETWORK_HOSTS: ReadonlySet<string> = new Set([
  "lvisai.xyz",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "models.github.ai",
]);

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

function extractDeclaredPaths(ctx: ToolInvocationContext): string[] {
  const paths: string[] = [];
  for (const field of ctx.pathFields) {
    const candidate = getDottedFieldValue(ctx.finalInput, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) paths.push(value);
    }
  }
  return [...new Set(paths)];
}

/**
 * Cheap dir-containment check: does `path` start with any allowed dir?
 * Allowed dirs are already canonicalized at Layer 1; we accept that as
 * input invariant and do plain prefix compare here (no realpath calls).
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
    if (host && TRUSTED_NETWORK_HOSTS.has(host)) {
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

  // ── write rules (3) ────────────────────────────────────
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
  return (
    `<UNTRUSTED_INPUT>\n` +
    `tool: ${input.toolName}\n` +
    `source: ${input.source}\n` +
    `category: ${input.category}\n` +
    `pathFields: ${JSON.stringify(input.pathFields)}\n` +
    `trustOrigin: ${input.trustOrigin}\n` +
    `input (DLP-redacted): ${JSON.stringify(redacted)}\n` +
    `allowedDirectories: ${JSON.stringify(input.allowedDirectories.slice(0, 8))}\n` +
    `sensitivePathsAdjacent: ${JSON.stringify(input.sensitivePathsAdjacent.slice(0, 8))}\n` +
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

export interface LlmRiskClassifierTelemetry {
  onCall?(stats: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    parseFailed: boolean;
  }): void;
}

export class LlmRiskClassifier implements RiskClassifier {
  private readonly rule = new RuleBasedRiskClassifier();

  constructor(
    private readonly provider: LlmReviewerProvider,
    private readonly model: string,
    private readonly fallbackOnError: FallbackOnError = "deny",
    private readonly telemetry: LlmRiskClassifierTelemetry = {},
  ) {}

  async classify(input: ToolInvocationContext): Promise<RiskVerdict> {
    // Composition baseline (security M1) — rule first, LLM cannot downgrade.
    const ruleVerdict = this.rule.classify(input);

    let llmVerdict: RiskVerdict;
    try {
      const userPrompt = buildUserPrompt(input);
      const completion = await this.provider.complete({
        model: this.model,
        systemPrompt: PERMISSION_REVIEWER_SYSTEM_PROMPT,
        userPrompt,
      });
      const parsed = tryParseVerdict(completion.text);
      this.telemetry.onCall?.({
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        costUsd: completion.costUsd,
        parseFailed: parsed === null,
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
      // Any provider error → fallbackOnError policy
      this.telemetry.onCall?.({ tokensIn: 0, tokensOut: 0, costUsd: 0, parseFailed: true });
      if (this.fallbackOnError === "deny") {
        const msg = (err as Error).message?.slice(0, 60) ?? "error";
        return { level: "high", reason: `llm error — fallback=deny (${msg})` };
      }
      return ruleVerdict;
    }

    return maxVerdict(ruleVerdict, llmVerdict);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

export type ReviewerMode = "disabled" | "rule" | "llm";

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
export const _internal = { buildUserPrompt, tryParseVerdict, RULES, PERMISSION_REVIEWER_SYSTEM_PROMPT };
