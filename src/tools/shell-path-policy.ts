import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";

const DYNAMIC_PATH_COMPOSITION_COMMANDS = new Set(["join-path"]);

export function validateShellWorkingDirectory(
  cwd: string,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
): string | null {
  const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (sensitive) {
    return `Sensitive path: cwd ${cwd} matches ${sensitive}`;
  }
  const check = validateSandboxPath(cwd, sandboxRoot, [...allowedDirectories]);
  return check.allowed ? null : `Sandbox: ${check.reason}`;
}

export function validateShellCommandPathPolicy(
  command: string,
  cwd: string,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
): string | null {
  const dynamicPathComposition = findDynamicPathComposition(command);
  if (dynamicPathComposition) {
    return dynamicPathComposition;
  }
  const candidates = extractPathCandidates(command);
  for (const candidate of candidates) {
    let absolute: string;
    try {
      absolute = resolveCandidatePath(candidate, cwd);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absolute)));
    if (sensitive) {
      return `Sensitive path: command operand ${candidate} matches ${sensitive}`;
    }
    const check = validateSandboxPath(absolute, sandboxRoot, [...allowedDirectories]);
    if (!check.allowed) {
      return `Sandbox: ${check.reason}`;
    }
  }
  return null;
}

function findDynamicPathComposition(command: string): string | null {
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
  return isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
    ? pathResolve(expanded)
    : pathResolve(cwd, expanded);
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
