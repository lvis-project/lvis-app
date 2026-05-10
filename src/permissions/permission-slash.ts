/**
 * Permission policy — `/permission` slash parser + dispatcher helpers.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 1
 * (slash commands), §11 v2.1 binding decisions.
 *
 * This module returns structured results so callers can render command
 * results without re-parsing and can enforce trust origin at one boundary.
 *
 * Trust origin gate (spec C2 fix): only `user-keyboard` may dispatch
 * `/permission` mutations. This module enforces that boundary and returns
 * structured outcomes so callers do not re-parse command text.
 */
import {
  validateDirectoryAddition,
  buildAllowedScope,
} from "./allowed-directories.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import {
  addAllowedDirectoryPersist,
  removeAllowedDirectoryPersist,
  readPermissionSettings,
  setReviewerSettingsPersist,
  type ReviewerMode,
  type ReviewerProvider,
  type ReviewerSettingsBlock,
} from "./permission-settings-store.js";
import {
  acceptHookTrust,
  disableHookTrust,
  listHookTrustState,
  rejectHookTrust,
  type HookTrustCommandOptions,
  type HookTrustCommandResult,
} from "../hooks/hook-trust-commands.js";
export { stripLeadingSlash } from "../shared/slash-sanitizer.js";
import { stripLeadingSlash } from "../shared/slash-sanitizer.js";
import {
  readRecentAuditEntries,
  summarizeAuditDir,
  verifyAllAuditFiles,
} from "./permission-audit-runner.js";
import type { PermissionAuditEntry } from "../audit/audit-schema.js";
import type { SecretStore } from "../audit/hmac-chain.js";

export type PermissionDirVerb = "allow" | "deny" | "list";

export interface PermissionDirCommand {
  verb: PermissionDirVerb;
  /** Path argument for allow/deny. Empty string for `list`. */
  path: string;
  /** `--session` flag for in-memory-only allow (allow-once). */
  session: boolean;
  /** Required before persisting paths with adjacency warnings. */
  acknowledgeWarnings: boolean;
}

export type PermissionDirResult =
  | { ok: true; verb: "allow"; persisted: string[]; sessionOnly: boolean; warnings: string[]; sessionDirectory?: string }
  | { ok: true; verb: "deny"; persisted: string[] }
  | { ok: true; verb: "list"; defaults: string[]; userAdditions: string[]; effective: string[] }
  | { ok: false; error: string; warnings?: string[]; requiresAcknowledgement?: boolean };

/**
 * Parse a `/permission dir ...` invocation. Accepts the full subcommand
 * string AFTER `/permission dir` (so the dispatcher can hand off the
 * remainder).
 *
 * Examples:
 *   "allow ~/Documents/old-project"
 *   "allow ~/foo --session"
 *   "deny /tmp/staging"
 *   "list"
 */
export function parsePermissionDirCommand(
  rawArgs: string,
): PermissionDirCommand | { ok: false; error: string } {
  const tokenized = tokenizePermissionArgs(rawArgs);
  if (!tokenized.ok) return tokenized;
  const args = tokenized.tokens;
  if (args.length === 0) {
    return { ok: false, error: "missing subcommand — usage: /permission dir <allow|deny|list> [path] [--session]" };
  }
  const verb = args[0] as PermissionDirVerb;
  if (verb !== "allow" && verb !== "deny" && verb !== "list") {
    return { ok: false, error: `unknown subcommand '${verb}' — expected allow|deny|list` };
  }
  if (verb === "list") {
    if (args.length > 1) {
      return { ok: false, error: "list takes no extra arguments" };
    }
    return { verb, path: "", session: false, acknowledgeWarnings: false };
  }
  const session = args.includes("--session");
  const acknowledgeWarnings = args.includes("--ack-warnings");
  const remaining = args.slice(1).filter((a) => a !== "--session" && a !== "--ack-warnings");
  if (remaining.length === 0) {
    return { ok: false, error: `${verb} requires a path argument` };
  }
  if (remaining.length > 1) {
    return { ok: false, error: `${verb} takes a single path (got ${remaining.length})` };
  }
  if (verb === "deny" && session) {
    return { ok: false, error: "--session is not valid for deny" };
  }
  if (verb === "deny" && acknowledgeWarnings) {
    return { ok: false, error: "--ack-warnings is not valid for deny" };
  }
  return { verb, path: remaining[0], session, acknowledgeWarnings };
}

function tokenizePermissionArgs(rawArgs: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of rawArgs.trim()) {
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }

  if (escaping) return { ok: false, error: "unterminated escape in quoted argument" };
  if (quote) return { ok: false, error: "unterminated quoted argument" };
  if (token.length > 0) tokens.push(token);
  return { ok: true, tokens };
}

/**
 * Dispatch a parsed command. Side effects:
 *   - `allow` (no --session) → persist to ~/.lvis/settings.json.
 *   - `allow --session` → no persist; caller owns live-scope mutation.
 *   - `deny` → remove from ~/.lvis/settings.json (settings-level).
 *     Layer 0 sensitive-paths is the actual hard-deny — `deny` here is
 *     just removing from the user's own list.
 *   - `list` → read current state.
 *
 * `pathOverride` is for tests (settings file location).
 */
export async function dispatchPermissionDirCommand(
  cmd: PermissionDirCommand,
  pathOverride?: string,
): Promise<PermissionDirResult> {
  if (cmd.verb === "list") {
    const current = readPermissionSettings(pathOverride);
    const userAdditions = current.permissions.additionalDirectories;
    const effective = buildAllowedScope(userAdditions).directories;
    // The defaults are the entries in `effective` that are NOT in
    // `userAdditions` after sanitize. Surfacing both helps the UI
    // distinguish provenance.
    const defaults = effective.filter((d) => !userAdditions.includes(d));
    return { ok: true, verb: "list", defaults, userAdditions, effective };
  }
  if (cmd.verb === "allow") {
    const validation = validateDirectoryAddition(cmd.path);
    if (!validation.ok) return { ok: false, error: validation.reason };
    if (validation.adjacencyWarnings.length > 0 && !cmd.acknowledgeWarnings) {
      return {
        ok: false,
        error: "directory has adjacency warnings; explicit acknowledgement required",
        warnings: validation.adjacencyWarnings,
        requiresAcknowledgement: true,
      };
    }
    if (cmd.session) {
      // Phase 5 will plumb this into the in-memory scope. For now we
      // surface a structured response so the dispatcher can update the
      // live executor context.
      return {
        ok: true,
        verb: "allow",
        persisted: [],
        sessionOnly: true,
        warnings: validation.adjacencyWarnings,
        sessionDirectory: validation.canonicalPath,
      };
    }
    const next = await addAllowedDirectoryPersist(cmd.path, pathOverride);
    return {
      ok: true,
      verb: "allow",
      persisted: next,
      sessionOnly: false,
      warnings: validation.adjacencyWarnings,
    };
  }
  // deny
  const next = await removeAllowedDirectoryPersist(cmd.path, pathOverride);
  return { ok: true, verb: "deny", persisted: next };
}

// ─── /permission reviewer slash ───────────────────────────────────────

export type PermissionReviewerVerb = "mode" | "provider" | "model" | "show";

export interface PermissionReviewerCommand {
  verb: PermissionReviewerVerb;
  /** For mode/provider/model: the new value. Empty string for `show`. */
  value: string;
}

export type PermissionReviewerResult =
  | { ok: true; verb: "show"; settings: ReviewerSettingsBlock }
  | { ok: true; verb: "mode"; settings: ReviewerSettingsBlock }
  | { ok: true; verb: "provider"; settings: ReviewerSettingsBlock }
  | { ok: true; verb: "model"; settings: ReviewerSettingsBlock }
  | { ok: false; error: string };

const VALID_REVIEWER_MODES: ReadonlySet<ReviewerMode> = new Set([
  "disabled",
  "rule",
  "llm",
]);
const VALID_REVIEWER_PROVIDERS: ReadonlySet<ReviewerProvider> = new Set([
  "openai",
  "anthropic",
  "google",
]);

/**
 * Parse `/permission reviewer ...` (the substring AFTER the prefix).
 *
 * Examples:
 *   "show"
 *   "mode disabled"
 *   "mode rule"
 *   "mode llm"
 *   "provider openai"
 *   "model gpt-4o-mini"
 */
export function parsePermissionReviewerCommand(
  rawArgs: string,
): PermissionReviewerCommand | { ok: false; error: string } {
  const args = rawArgs.trim().split(/\s+/).filter((p) => p.length > 0);
  if (args.length === 0) {
    return {
      ok: false,
      error:
        "missing subcommand — usage: /permission reviewer <show|mode|provider|model> [value]",
    };
  }
  const verb = args[0] as PermissionReviewerVerb;
  if (verb !== "mode" && verb !== "provider" && verb !== "model" && verb !== "show") {
    return { ok: false, error: `unknown subcommand '${verb}' — expected show|mode|provider|model` };
  }
  if (verb === "show") {
    if (args.length > 1) return { ok: false, error: "show takes no extra arguments" };
    return { verb, value: "" };
  }
  if (args.length < 2) {
    return { ok: false, error: `${verb} requires a value argument` };
  }
  if (args.length > 2) {
    return { ok: false, error: `${verb} takes a single value (got ${args.length - 1})` };
  }
  return { verb, value: args[1] };
}

/**
 * Dispatch a parsed reviewer command. Persists to ~/.lvis/settings.json
 * via {@link setReviewerSettingsPersist}.
 *
 * `pathOverride` is for tests.
 */
export async function dispatchPermissionReviewerCommand(
  cmd: PermissionReviewerCommand,
  pathOverride?: string,
): Promise<PermissionReviewerResult> {
  if (cmd.verb === "show") {
    const current = readPermissionSettings(pathOverride);
    return { ok: true, verb: "show", settings: current.permissions.reviewer };
  }
  if (cmd.verb === "mode") {
    if (!VALID_REVIEWER_MODES.has(cmd.value as ReviewerMode)) {
      return {
        ok: false,
        error: `invalid mode '${cmd.value}' — expected ${[...VALID_REVIEWER_MODES].join("|")}`,
      };
    }
    try {
      const settings = await setReviewerSettingsPersist(
        { mode: cmd.value as ReviewerMode },
        pathOverride,
      );
      return { ok: true, verb: "mode", settings };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  if (cmd.verb === "provider") {
    if (!VALID_REVIEWER_PROVIDERS.has(cmd.value as ReviewerProvider)) {
      return {
        ok: false,
        error: `invalid provider '${cmd.value}' — expected ${[...VALID_REVIEWER_PROVIDERS].join("|")}`,
      };
    }
    try {
      const settings = await setReviewerSettingsPersist(
        { provider: cmd.value as ReviewerProvider },
        pathOverride,
      );
      return { ok: true, verb: "provider", settings };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  // model
  if (cmd.value.length === 0) {
    return { ok: false, error: "model name cannot be empty" };
  }
  try {
    const settings = await setReviewerSettingsPersist(
      { model: cmd.value },
      pathOverride,
    );
    return { ok: true, verb: "model", settings };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── /permission audit ─────────────────────────────────────────────────

export type PermissionAuditVerb = "show" | "verify";

export interface PermissionAuditCommand {
  verb: PermissionAuditVerb;
  /** For `show`: how many entries to surface (default 50, max 1000). */
  last: number;
}

/**
 * Parse `/permission audit ...` (the substring AFTER the prefix).
 *
 * Examples:
 *   "show"
 *   "show --last=100"
 *   "verify"
 */
export function parsePermissionAuditCommand(
  rawArgs: string,
): PermissionAuditCommand | { ok: false; error: string } {
  const args = rawArgs.trim().split(/\s+/).filter((p) => p.length > 0);
  if (args.length === 0) {
    return { ok: false, error: "missing subcommand — usage: /permission audit <show|verify> [--last=N]" };
  }
  const verb = args[0] as PermissionAuditVerb;
  if (verb !== "show" && verb !== "verify") {
    return { ok: false, error: `unknown subcommand '${verb}' — expected show|verify` };
  }
  let last = 50;
  for (const arg of args.slice(1)) {
    const m = arg.match(/^--last=(\d+)$/);
    if (m) {
      const parsed = Number(m[1]);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return { ok: false, error: `--last must be a positive integer (got ${m[1]})` };
      }
      last = Math.min(parsed, 1000);
      continue;
    }
    return { ok: false, error: `unknown flag '${arg}'` };
  }
  if (verb === "verify" && last !== 50) {
    return { ok: false, error: "--last is only valid for 'show'" };
  }
  return { verb, last };
}

export type PermissionAuditResult =
  | {
      ok: true;
      verb: "show";
      entries: PermissionAuditEntry[];
      total: number;
      summary: { files: number; bytes: number };
    }
  | {
      ok: true;
      verb: "verify";
      intact: boolean;
      totalFiles: number;
      totalEntries: number;
      firstBrokenFile?: string;
    }
  | { ok: false; error: string };

export function dispatchPermissionAuditCommand(
  cmd: PermissionAuditCommand,
  opts: { auditDir: string; secret: string | null; sealStore?: SecretStore },
): PermissionAuditResult {
  if (cmd.verb === "show") {
    const entries = readRecentAuditEntries(opts.auditDir, cmd.last);
    return {
      ok: true,
      verb: "show",
      entries,
      total: entries.length,
      summary: summarizeAuditDir(opts.auditDir),
    };
  }
  if (!opts.secret) {
    return { ok: false, error: "audit-chain-not-initialized" };
  }
  const result = verifyAllAuditFiles(opts.auditDir, opts.secret, opts.sealStore);
  return {
    ok: true,
    verb: "verify",
    intact: result.intact,
    totalFiles: result.totalFiles,
    totalEntries: result.totalEntries,
    ...(result.firstBrokenFile ? { firstBrokenFile: result.firstBrokenFile } : {}),
  };
}

// ─── /permission mode ──────────────────────────────────────────────────

export type SlashPermissionMode = "strict" | "default" | "auto";

export interface PermissionModeCommand {
  verb: "mode";
  mode: SlashPermissionMode;
  durable: boolean;
}

const VALID_MODES: ReadonlySet<SlashPermissionMode> = new Set([
  "strict",
  "default",
  "auto",
]);

export function parsePermissionModeCommand(
  rawArgs: string,
): PermissionModeCommand | { ok: false; error: string } {
  const args = rawArgs.trim().split(/\s+/).filter((p) => p.length > 0);
  if (args.length === 0) {
    return {
      ok: false,
      error: "missing mode — usage: /permission mode <strict|default|auto> [--durable]",
    };
  }
  const candidate = args[0] as SlashPermissionMode;
  if (!VALID_MODES.has(candidate)) {
    return {
      ok: false,
      error: `invalid mode '${candidate}' — expected ${[...VALID_MODES].join("|")}`,
    };
  }
  const durable = args.includes("--durable");
  const extra = args.slice(1).filter((a) => a !== "--durable");
  if (extra.length > 0) {
    return { ok: false, error: `unknown extra argument(s): ${extra.join(", ")}` };
  }
  return { verb: "mode", mode: candidate, durable };
}

// ─── /permission rules / hooks ─────────────────────────────────────────

export type PermissionRulesCommand =
  | { verb: "rules"; sub: "list" }
  | { verb: "rules"; sub: "add" | "remove"; action: "allow" | "deny"; pattern: string };
export type PermissionHooksCommand =
  | { verb: "hooks"; sub: "list" }
  | { verb: "hooks"; sub: "accept"; name: string }
  | { verb: "hooks"; sub: "disable"; name: string }
  | { verb: "hooks"; sub: "reject"; name: string };

export function parsePermissionRulesCommand(
  rawArgs: string,
): PermissionRulesCommand | { ok: false; error: string } {
  const tokenized = tokenizePermissionArgs(rawArgs);
  if (!tokenized.ok) return tokenized;
  const args = tokenized.tokens;
  if (args.length === 1 && args[0] === "list") {
    return { verb: "rules", sub: "list" };
  }
  const sub = args[0];
  if (sub !== "add" && sub !== "remove") {
    return { ok: false, error: "usage: /permission rules <list|add|remove> [allow|deny] [pattern]" };
  }
  const action = args[1];
  if (action !== "allow" && action !== "deny") {
    return { ok: false, error: `${sub} requires action allow|deny` };
  }
  const pattern = args[2];
  if (!pattern) {
    return { ok: false, error: `${sub} requires a pattern` };
  }
  if (args.length > 3) {
    return { ok: false, error: `${sub} takes a single pattern` };
  }
  return { verb: "rules", sub, action, pattern };
}

export function parsePermissionHooksCommand(
  rawArgs: string,
): PermissionHooksCommand | { ok: false; error: string } {
  const args = rawArgs.trim().split(/\s+/).filter((p) => p.length > 0);
  if (args.length === 0) {
    return { ok: false, error: "usage: /permission hooks <list|accept|disable|reject> [name]" };
  }
  const sub = args[0];
  if (sub === "list") {
    if (args.length > 1) return { ok: false, error: "list takes no extra arguments" };
    return { verb: "hooks", sub: "list" };
  }
  if (sub === "accept" || sub === "disable" || sub === "reject") {
    if (args.length !== 2) {
      return { ok: false, error: `${sub} requires a hook name` };
    }
    return { verb: "hooks", sub, name: args[1] };
  }
  return {
    ok: false,
    error: `unknown subcommand '${sub}' — expected list|accept|disable|reject`,
  };
}

export async function dispatchPermissionHooksCommand(
  cmd: PermissionHooksCommand,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  switch (cmd.sub) {
    case "list":
      return listHookTrustState(opts);
    case "accept":
      return acceptHookTrust(cmd.name, opts);
    case "disable":
      return disableHookTrust(cmd.name, opts);
    case "reject":
      return rejectHookTrust(cmd.name, opts);
  }
}

// ─── Top-level /permission dispatcher (trust-origin gated) ─────────────

/**
 * Permission policy P5 — trust-origin set as defined in spec §9. Slash dispatch
 * is gated on `user-keyboard` only; everything else short-circuits
 * to plain-text echo (per spec §3 Layer 8).
 */
export type SlashTrustOrigin = ChatInputOrigin | "unknown";

/**
 * Top-level dispatch result. The renderer's slash handler turns
 * this into either a parsed command + side-effect, a modal
 * confirmation request (durable mutations), or plain-text echo.
 */
export type PermissionSlashOutcome =
  | { kind: "rejected-non-user-origin"; sanitized: string }
  | { kind: "show-current"; needsModal: false }
  | { kind: "audit"; cmd: PermissionAuditCommand; needsModal: false }
  | { kind: "dir"; cmd: PermissionDirCommand; needsModal: false }
  | { kind: "reviewer"; cmd: PermissionReviewerCommand; needsModal: false }
  | { kind: "mode"; cmd: PermissionModeCommand; needsModal: boolean }
  | { kind: "rules"; cmd: PermissionRulesCommand; needsModal: false }
  | { kind: "hooks"; cmd: PermissionHooksCommand; needsModal: boolean }
  | { kind: "parse-error"; error: string };

/**
 * Permission policy P5 — central dispatcher entry point. The renderer calls this
 * with the raw input string + the propagated trust origin. The
 * dispatcher's contract:
 *
 *   1. If trustOrigin !== "user-keyboard" → return rejected with
 *      a sanitized version (leading `/` stripped, per spec §3 Layer 8).
 *   2. If the input doesn't start with `/permission` → caller-error
 *      (the dispatcher is only reached when the prefix matched).
 *   3. Otherwise parse the subcommand and return an outcome that
 *      tells the caller whether a modal confirmation is required
 *      (durable mode change, durable hook accept).
 */
export function dispatchPermissionSlash(
  rawInput: string,
  trustOrigin: SlashTrustOrigin,
): PermissionSlashOutcome {
  if (trustOrigin !== "user-keyboard") {
    return {
      kind: "rejected-non-user-origin",
      sanitized: stripLeadingSlash(rawInput),
    };
  }
  const trimmed = rawInput.trim();
  if (trimmed === "/permission") {
    return { kind: "show-current", needsModal: false };
  }
  if (!trimmed.startsWith("/permission ")) {
    return {
      kind: "parse-error",
      error: "input does not match /permission ... grammar",
    };
  }
  const remainder = trimmed.slice("/permission ".length).trim();
  const head = remainder.split(/\s+/, 1)[0];
  const tail = remainder.slice(head.length).trim();

  switch (head) {
    case "audit": {
      const parsed = parsePermissionAuditCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      return { kind: "audit", cmd: parsed as PermissionAuditCommand, needsModal: false };
    }
    case "dir": {
      const parsed = parsePermissionDirCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      return { kind: "dir", cmd: parsed as PermissionDirCommand, needsModal: false };
    }
    case "reviewer": {
      const parsed = parsePermissionReviewerCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      return { kind: "reviewer", cmd: parsed as PermissionReviewerCommand, needsModal: false };
    }
    case "mode": {
      const parsed = parsePermissionModeCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      // Durable mutations require modal confirmation regardless of
      // origin (spec §3 Layer 8 — even from user-keyboard, durable
      // changes need an explicit button click).
      return {
        kind: "mode",
        cmd: parsed as PermissionModeCommand,
        needsModal: (parsed as PermissionModeCommand).durable,
      };
    }
    case "rules": {
      const parsed = parsePermissionRulesCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      return { kind: "rules", cmd: parsed as PermissionRulesCommand, needsModal: false };
    }
    case "hooks": {
      const parsed = parsePermissionHooksCommand(tail);
      if ("ok" in parsed && parsed.ok === false) {
        return { kind: "parse-error", error: parsed.error };
      }
      const cmd = parsed as PermissionHooksCommand;
      // Hook trust changes are slash-based TOFU: the typed user-keyboard
      // command is the approval surface. Production intentionally has no
      // renderer approval prompt for untrusted hooks.
      return { kind: "hooks", cmd, needsModal: false };
    }
    default:
      return {
        kind: "parse-error",
        error: `unknown subcommand '${head}' — expected mode|dir|reviewer|rules|hooks|audit`,
      };
  }
}
