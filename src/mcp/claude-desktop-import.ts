/**
 * #FU262 — Claude Desktop config importer.
 *
 * Maps the Claude Desktop `claude_desktop_config.json` schema onto LVIS's
 * `McpServerConfig` discriminated union so users migrating from Claude
 * Desktop don't have to rewrite their MCP entries by hand.
 *
 * Claude Desktop format (stdio-only, as documented in modelcontextprotocol/quickstart):
 *
 *   {
 *     "mcpServers": {
 *       "<id>": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *         "env": { "API_KEY": "..." }
 *       },
 *       ...
 *     }
 *   }
 *
 * The mapper:
 *   - parses + validates the raw JSON
 *   - rejects malformed entries (missing command, non-string args, etc.)
 *   - heuristically flags env values that look like secrets so the renderer
 *     can prompt the user to move them into the OS keychain instead of
 *     persisting plaintext in `mcp-servers.json`
 *
 * Out of scope (separate FU): VSCode / Cline config formats, automatic
 * keychain extraction (we surface the heuristic but defer the storage
 * decision to the renderer / user).
 */

import type { McpServerConfig } from "./types.js";

export interface ClaudeDesktopImportEntry {
  /** Source key from `mcpServers` — used as the LVIS server id. */
  id: string;
  config: McpServerConfig;
  /** Env keys whose values look like secrets (heuristic). */
  suspectedSecretEnvKeys: string[];
  /** Best-effort warning text — empty string when import is clean. */
  warning?: string;
}

export interface ClaudeDesktopImportResult {
  entries: ClaudeDesktopImportEntry[];
  /** IDs that failed to parse — surfaced so the renderer can show them. */
  errors: Array<{ id: string; reason: string }>;
}

/**
 * Heuristic: an env key is "suspected secret" if its uppercase form
 * contains any of these tokens. The list intentionally errs toward
 * false-positive — better to prompt the user once than silently persist
 * plaintext credentials. Loop #5 security review M-2 expanded the list
 * to cover the most common foot-guns we saw in real-world MCP configs.
 */
const SECRET_KEY_PATTERNS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASS",
  "AUTH",
  "CREDENTIAL",
  "BEARER",
  "JWT",
  "COOKIE",
  "SESSION",
  "DSN",
  "PRIVATE",
  "SIGNATURE",
  "APIKEY",
];

/**
 * Heuristic: a value looks like a secret if it matches one of the
 * well-known credential formats. Catches cases where the env *name* is
 * generic (e.g. `MY_SETTING`) but the value is unmistakably a token.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$/, // GitHub PAT
  /^sk-[A-Za-z0-9_-]{20,}$/, // OpenAI / Anthropic-style
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack
];

function looksLikeSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEY_PATTERNS.some((p) => upper.includes(p));
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Parse a raw Claude Desktop config string into LVIS-shaped MCP entries.
 *
 * Always returns a result object — never throws. Per-entry parse failures
 * collect into `errors` so the renderer can show them alongside the
 * successful imports.
 *
 * Rejection rules:
 *   - top-level not an object / `mcpServers` missing → empty result, single error
 *   - per-entry: missing or non-string `command` → entry-level error
 *   - per-entry: non-array args / non-string args entries → entry-level error
 *   - per-entry: env that is not a `Record<string, string>` → entry-level error
 *
 * Imports always come back as `transport: "stdio"`. Claude Desktop only
 * supports stdio MCP servers; the LVIS HTTP transport stays opt-in via
 * the manual McpTab form.
 */
export function parseClaudeDesktopConfig(raw: string): ClaudeDesktopImportResult {
  const result: ClaudeDesktopImportResult = { entries: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push({ id: "<root>", reason: `not valid JSON: ${(err as Error).message}` });
    return result;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.errors.push({ id: "<root>", reason: "config must be a JSON object" });
    return result;
  }
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    result.errors.push({ id: "<root>", reason: "missing `mcpServers` object" });
    return result;
  }

  for (const [rawId, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    const id = rawId.trim();
    if (!id) {
      result.errors.push({ id: rawId, reason: "empty id" });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      result.errors.push({ id, reason: "entry must be an object" });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const command = entry.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      result.errors.push({ id, reason: "missing or invalid `command`" });
      continue;
    }
    let args: string[] | undefined;
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args)) {
        result.errors.push({ id, reason: "`args` must be a string array" });
        continue;
      }
      const allStrings = entry.args.every((a): a is string => typeof a === "string");
      if (!allStrings) {
        result.errors.push({ id, reason: "`args` entries must all be strings" });
        continue;
      }
      args = entry.args as string[];
    }
    let env: Record<string, string> | undefined;
    let suspectedSecretEnvKeys: string[] = [];
    if (entry.env !== undefined) {
      if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
        result.errors.push({ id, reason: "`env` must be an object of string key/value pairs" });
        continue;
      }
      const envObj = entry.env as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      let invalid = false;
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof v !== "string") {
          result.errors.push({
            id,
            reason: `\`env.${k}\` must be a string (got ${typeof v})`,
          });
          invalid = true;
          break;
        }
        cleaned[k] = v;
        // Flag if EITHER the key name OR the value shape looks like a
        // secret. The empty-value placeholder convention (`API_KEY: ""`)
        // is intentionally NOT flagged — see below.
        if (v.length > 0 && (looksLikeSecretKey(k) || looksLikeSecretValue(v))) {
          suspectedSecretEnvKeys.push(k);
        }
      }
      if (invalid) continue;
      if (Object.keys(cleaned).length > 0) env = cleaned;
    }

    // NOTE (worker-egress PR1): `sandboxRoot` is deliberately NOT set here. The
    // filesystem-jail root for the ASRT-wrapped stdio worker is HOST-derived at
    // connect time (`McpManager.connectServer` → `~/.lvis/mcp/<id>/sandbox/`),
    // never from imported/persisted config — a config-supplied jail root would
    // defeat the jail. It is also not persisted to servers.json.
    const config: McpServerConfig = {
      id,
      transport: "stdio",
      command: command.trim(),
      args,
      env,
      auth: "none",
    };
    const importEntry: ClaudeDesktopImportEntry = {
      id,
      config,
      suspectedSecretEnvKeys,
    };
    if (suspectedSecretEnvKeys.length > 0) {
      importEntry.warning =
        `Detected ${suspectedSecretEnvKeys.length} env value(s) that look like secrets ` +
        `(${suspectedSecretEnvKeys.join(", ")}). Consider moving them to the OS keychain ` +
        `via the api-key flow instead of persisting in mcp-servers.json.`;
    }
    result.entries.push(importEntry);
  }

  return result;
}
