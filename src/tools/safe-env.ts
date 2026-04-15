/**
 * Portions adapted from OpenHarness hardening discussion (MIT License).
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * Safe child-process environment builder (Tier H2).
 *
 * Whitelist-based forwarding of environment variables to spawned children.
 * Every caller that shells out (bash tool, external command hooks) MUST go
 * through {@link buildSafeChildEnv} so that secrets stored in the host
 * process env (API keys, auth tokens, etc.) are NEVER visible to the
 * child. Anything not explicitly listed in {@link FORWARD_ENV_KEYS} is
 * stripped — this includes `LVIS_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `GOOGLE_*`, `AWS_*`, `GITHUB_TOKEN`, and any future provider secrets.
 */

/**
 * Environment variables safe to forward to child processes. Only generic
 * shell / locale / path variables needed for most tools to run correctly.
 * Provider API keys and LVIS-internal variables are intentionally omitted.
 */
const FORWARD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
] as const;

/**
 * Build a minimal environment for a spawned child process.
 *
 * @param extra Additional key/value pairs to merge on top of the safe
 *   baseline. Typically used by hook runners to set `LVIS_HOOK_*`
 *   variables that the child explicitly needs. Keys in `extra` override
 *   the whitelist if they happen to collide.
 * @returns A fresh object containing only the whitelisted variables
 *   plus `extra`. Suitable for passing directly as `spawn`'s `env`.
 */
export function buildSafeChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  return { ...safe, ...extra };
}
