/**
 * Shared name-validation constants for MCP governance.
 *
 * Single source of truth for env-var and HTTP-header name constraints.
 * Both mcp-governance.ts and mcp-runtime-spec.ts import from here so
 * the two validation paths can never silently diverge (MEDIUM-6).
 */

/** POSIX env-var name syntax: starts with letter or underscore, followed by word chars. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 7230 token grammar for HTTP header field names. */
export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Maximum length for apiKeyEnv and apiKeyHeader names. */
export const MAX_NAME_LEN = 64;

/**
 * Env-var names that are dangerous to override via a manifest:
 * injecting an apiKey value into any of these could allow RCE via
 * shared-object injection (LD_PRELOAD, DYLD_INSERT_LIBRARIES),
 * interpreter startup-file hijacking (BASH_ENV, PYTHONSTARTUP),
 * or node-flag injection (NODE_OPTIONS) in spawned MCP child processes.
 *
 * Checked case-insensitively (CRITICAL-1).
 */
export const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LANG",
  "NODE_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
]);

/**
 * HTTP header names that must not be used as apiKeyHeader targets.
 *
 * Authorization/Cookie carry authentication material that must be set by
 * the host, not by a plugin manifest. Hop-by-hop headers (Connection,
 * Transfer-Encoding, etc.) and forwarding headers are spec-reserved and
 * can cause request smuggling or SSRF amplification if overridden.
 *
 * Checked case-insensitively (HIGH-1).
 */
export const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
