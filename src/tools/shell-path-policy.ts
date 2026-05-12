import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";

export type ShellPathPolicyViolationKind =
  | "dynamic-path"
  | "invalid-path"
  | "recursive-traversal"
  | "sandbox-boundary"
  | "sensitive-path";

export interface ShellPathPolicyViolation {
  kind: ShellPathPolicyViolationKind;
  reason: string;
  candidate?: string;
  path?: string;
}

const DYNAMIC_PATH_COMPOSITION_COMMANDS = new Set([
  "join-path",
  "resolve-path",
  "convert-path",
  "new-psdrive",
]);

const BARE_SENSITIVE_FILENAMES = [
  /^\.env(?:\..*)?$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^\.bash_history$/i,
  /^\.zsh_history$/i,
  /^\.python_history$/i,
  /^\.psql_history$/i,
  /^\.viminfo$/i,
  /^id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/i,
  /^credentials$/i,
  /^config\.json$/i,
  /^Login Data$/i,
];

const RECURSIVE_TRAVERSAL_COMMANDS = new Set([
  "fd",
  "fdfind",
  "find",
  "rg",
  "tar",
  "tree",
  "unzip",
  "zip",
]);

const RECURSIVE_FLAG_COMMANDS = new Map<string, readonly string[]>([
  ["cp", ["-r", "-R", "--recursive"]],
  ["du", ["-a", "--all"]],
  ["egrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["fgrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["grep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["ls", ["-R"]],
  ["mv", ["-r", "-R", "--recursive"]],
]);

const SHELL_NULL_DEVICE_PATH = "/dev/null";

export function validateShellWorkingDirectory(
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): string | null {
  const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (sensitive) {
    return `Sensitive path: cwd ${cwd} matches ${sensitive}`;
  }
  const check = validateSandboxPath(cwd, sandboxRoot, [...extraAllowedDirectories]);
  return check.allowed ? null : `Sandbox: ${check.reason}`;
}

export function findShellPathPolicyViolation(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const cwdSensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (cwdSensitive) {
    return {
      kind: "sensitive-path",
      reason: `Sensitive path: cwd ${cwd} matches ${cwdSensitive}`,
      path: cwd,
    };
  }
  const cwdCheck = validateSandboxPath(cwd, sandboxRoot, [...extraAllowedDirectories]);
  if (!cwdCheck.allowed) {
    return {
      kind: "sandbox-boundary",
      reason: `Sandbox: ${cwdCheck.reason}`,
      path: cwd,
    };
  }

  const recursiveTraversal = findUnsafeRecursiveTraversal(command);
  if (recursiveTraversal) {
    return { kind: "recursive-traversal", reason: recursiveTraversal };
  }
  const dynamicPathComposition = findDynamicPathComposition(command);
  if (dynamicPathComposition) {
    return { kind: "dynamic-path", reason: dynamicPathComposition };
  }
  const candidates = extractPathCandidates(command);
  for (const candidate of candidates) {
    if (isIgnoredShellDeviceCandidate(candidate)) {
      continue;
    }
    let absolute: string;
    try {
      absolute = resolveCandidatePath(candidate, cwd);
    } catch (err) {
      return {
        kind: "invalid-path",
        reason: err instanceof Error ? err.message : String(err),
        candidate,
      };
    }
    if (isIgnoredShellDevicePath(absolute)) {
      continue;
    }
    const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absolute)));
    if (sensitive) {
      return {
        kind: "sensitive-path",
        reason: `Sensitive path: command operand ${candidate} matches ${sensitive}`,
        candidate,
        path: absolute,
      };
    }
    const check = validateSandboxPath(absolute, sandboxRoot, [...extraAllowedDirectories]);
    if (!check.allowed) {
      return {
        kind: "sandbox-boundary",
        reason: `Sandbox: ${check.reason}`,
        candidate,
        path: absolute,
      };
    }
  }
  return null;
}

function isIgnoredShellDevicePath(canonicalPath: string): boolean {
  return canonicalPath === SHELL_NULL_DEVICE_PATH;
}

function isIgnoredShellDeviceCandidate(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  return normalized === SHELL_NULL_DEVICE_PATH || normalized === "nul";
}

export function validateShellCommandPathPolicy(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): string | null {
  return findShellPathPolicyViolation(command, cwd, sandboxRoot, extraAllowedDirectories)?.reason ?? null;
}

function findUnsafeRecursiveTraversal(command: string): string | null {
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeCommand(segment);
    const commandIndex = tokens.findIndex((token) => !isAssignmentToken(token));
    if (commandIndex < 0) continue;
    const commandName = normalizeCommandName(tokens[commandIndex]);
    if (!commandName) continue;
    if (RECURSIVE_TRAVERSAL_COMMANDS.has(commandName)) {
      return `Sandbox: recursive shell filesystem traversal is not allowed: ${tokens[commandIndex]}`;
    }
    const recursiveFlags = RECURSIVE_FLAG_COMMANDS.get(commandName);
    if (recursiveFlags) {
      const args = tokens.slice(commandIndex + 1);
      const flag = args.find((arg) => recursiveFlags.some((candidate) => hasShellFlag(arg, candidate)));
      if (flag) {
        return `Sandbox: recursive shell filesystem traversal is not allowed: ${tokens[commandIndex]} ${flag}`;
      }
    }
  }
  return null;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      segment += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      segment += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      segment += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      segment += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      if (segment.trim()) segments.push(segment);
      segment = "";
      continue;
    }
    segment += ch;
  }
  if (segment.trim()) segments.push(segment);
  return segments;
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function normalizeCommandName(token: string): string {
  const cleaned = token
    .replace(/^[({]+/g, "")
    .replace(/[),]+$/g, "")
    .trim();
  const basename = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return basename.toLowerCase();
}

function hasShellFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (flag.length === 2 && /^-[A-Za-z]+$/.test(token)) {
    return token.slice(1).includes(flag[1]);
  }
  if (flag.startsWith("--")) {
    return token === flag || token.startsWith(flag + "=");
  }
  return false;
}

function findDynamicPathComposition(command: string): string | null {
  if (hasDynamicPathExpression(command)) {
    return "Sandbox: dynamic path composition is not allowed";
  }
  for (const token of tokenizeCommand(command)) {
    const normalized = token
      .replace(/^[({]+/g, "")
      .replace(/[),]+$/g, "")
      .trim()
      .toLowerCase();
    if (DYNAMIC_PATH_COMPOSITION_COMMANDS.has(normalized)) {
      return `Sandbox: dynamic path composition is not allowed: ${token}`;
    }
  }
  return null;
}

function hasDynamicPathExpression(command: string): boolean {
  return (
    /\[(?:system\.)?io\.path\]::combine\s*\(/i.test(command) ||
    /\$(?:home|env:home|pwd|env:pwd|tmpdir|env:tmpdir)\b[^|;\n]*\+/.test(command) ||
    /\+[^|;\n]*\$(?:home|env:home|pwd|env:pwd|tmpdir|env:tmpdir)\b/i.test(command)
  );
}

function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const token of tokenizeCommand(command)) {
    for (const part of splitCandidateParts(token)) {
      const normalized = normalizeCandidate(part);
      if (normalized && looksLikePath(normalized)) {
        candidates.push(normalized);
      }
    }
  }
  return [...new Set(candidates)];
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      token += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === "|" || ch === ";") {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }
  if (token) tokens.push(token);
  return tokens;
}

function splitCandidateParts(token: string): string[] {
  const parts = [token];
  const eq = token.indexOf("=");
  if (eq > 0 && eq < token.length - 1) {
    parts.push(token.slice(eq + 1));
  }
  for (const part of token.split(/\d*(?:>>?|<<?|&>|2>|2>>)+/g)) {
    if (part && part !== token) parts.push(part);
  }
  return parts;
}

function normalizeCandidate(token: string): string | null {
  const trimmed = token
    .replace(/^\d*(?:>>?|<<?|&>|2>|2>>)+/, "")
    .replace(/[),]+$/g, "")
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikePath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (BARE_SENSITIVE_FILENAMES.some((pattern) => pattern.test(value))) return true;
  return (
    value === "~" ||
    /^~[^/\\]+$/.test(value) ||
    /^~[^/\\]+[/\\]/.test(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function resolveCandidatePath(value: string, cwd: string): string {
  const expandedVars = expandShellPathVariables(value, cwd);
  if (expandedVars.includes("$") || expandedVars.includes("%")) {
    throw new Error(`Sandbox: unresolved shell variable in path operand ${value}`);
  }
  if (
    expandedVars.startsWith("~") &&
    expandedVars !== "~" &&
    !expandedVars.startsWith("~/") &&
    !expandedVars.startsWith("~\\")
  ) {
    throw new Error(`Sandbox: unsupported user-home expansion in path operand ${value}`);
  }
  const expanded = expandedVars === "~"
    ? homedir()
    : expandedVars.startsWith("~/") || expandedVars.startsWith("~\\")
      ? pathResolve(homedir(), expandedVars.slice(2))
      : expandedVars;
  const resolved = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
    ? pathResolve(expanded)
    : pathResolve(cwd, expanded);
  return canonicalizePathForMatch(resolved);
}

function expandShellPathVariables(value: string, cwd: string): string {
  const tmpDir = process.env.TMPDIR;
  return value
    .replace(/\$\{HOME\}|\$HOME|\$env:HOME/g, homedir())
    .replace(/\$\{PWD\}|\$PWD|\$env:PWD/g, cwd)
    .replace(/\$\{TMPDIR\}|\$TMPDIR|\$env:TMPDIR/g, tmpDir ?? "$TMPDIR")
    .replace(/%USERPROFILE%/gi, homedir())
    .replace(/%CD%/gi, cwd)
    .replace(/%TMP%|%TEMP%/gi, tmpDir ?? "%TMP%");
}
