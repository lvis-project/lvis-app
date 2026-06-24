/**
 * Safe child-process environment builder.
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

/**
 * The exact set of environment variables ASRT is permitted to add or change on
 * the sandboxed child's env. Sourced from the sandbox-runtime egress plumbing
 * (`dist/sandbox/sandbox-utils.js` — `CA_TRUST_VARS` + the per-tool proxy
 * `envVars.push(...)` block + `TMPDIR`). Anything ASRT might emit outside this
 * list is NOT propagated.
 *
 * Why an explicit allow-list (PR #1356 correctness MAJOR): the previous
 * "overlay any wrapped.env key that DIFFERS from process.env" rule was
 * open-ended. A stripped secret only stays stripped because its value happens
 * to be identical in `process.env` and `wrapped.env`. If a future ASRT version
 * MUTATED an existing host var that also held a secret (e.g. re-exported a
 * provider key under a new value), the "differs" test would match and the
 * secret would re-leak past the {@link buildSafeChildEnv} whitelist. Pinning
 * the propagated keys to this known list closes that re-leak by construction.
 */
const ASRT_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  // Proxy vars (upper + lower case) ASRT points at its localhost egress proxy.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
  "RSYNC_PROXY",
  "GRPC_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ftp_proxy",
  "grpc_proxy",
  // Per-tool proxy + proxy-auth vars ASRT sets for specific clients.
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "CLOUDSDK_PROXY_USERNAME",
  "CLOUDSDK_PROXY_PASSWORD",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH_COMMAND",
  // CA-trust store vars pointed at the TLS-termination CA cert (CA_TRUST_VARS).
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  // Sandbox-scoped temp dir.
  "TMPDIR",
]);

/**
 * Compose the env for an ASRT-sandboxed child.
 *
 * ASRT's `wrapWithSandboxArgv` returns `env` = the parent `process.env` plus
 * the proxy / CA-cert variables it ADDS for sandbox networking (HTTP_PROXY,
 * ALL_PROXY, NODE_EXTRA_CA_CERTS, …). Passing that env verbatim would leak the
 * host secrets the {@link buildSafeChildEnv} whitelist exists to strip.
 *
 * We start from the safe whitelist baseline and overlay ONLY the keys in
 * {@link ASRT_SANDBOX_ENV_KEYS} (the explicit, known set ASRT is allowed to
 * inject). A key is propagated only when it is allow-listed AND ASRT actually
 * set/changed it relative to `process.env` — so a host var ASRT left untouched
 * never leaks, and a non-allow-listed key ASRT might emit is never propagated
 * even if it differs from `process.env`.
 */
export function buildSandboxedChildEnv(
  wrappedEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env = buildSafeChildEnv();
  for (const key of ASRT_SANDBOX_ENV_KEYS) {
    const value = wrappedEnv[key];
    if (value === undefined) continue;
    if (process.env[key] === value) continue; // ASRT left it untouched
    env[key] = value;
  }
  return env;
}
