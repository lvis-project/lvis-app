/**
 * cli/http-client.ts — #1436 HTTP client transport for the LVIS CLI (#1409
 * follow-up).
 *
 * Two pieces that let the CLI reach the running loopback local API server:
 *
 *   1. {@link readLocalApiConnection} — discovers the server by reading the
 *      main process's discovery file (`~/.lvis/local-api/server.json`) through
 *      the SAME feature-namespace path helper the main module writes it with
 *      ({@link openFeatureNamespace}), so the path + shape have ONE source of
 *      truth. Returns null when the server is not running (missing file, or a
 *      tombstone with port<=0 / empty secret).
 *
 *   2. {@link createHttpLocalApi} — wraps a {@link CliConnection} as a
 *      {@link LocalApi} whose `dispatch` POSTs to `/v1/dispatch` with a Bearer
 *      secret. Because it implements the `LocalApi` interface, the CLI feeds it
 *      to {@link createLvisClient}(httpApi, "cli") and gets the full typed
 *      client for free — the SDK facade stays the single source of the client.
 *
 * TRANSPORT ORIGIN: the request body carries ONLY `{ channel, args }` — matching
 * the server's `parseDispatchBody` wire (see `src/api/http-server.ts`). The
 * server injects `origin: "local-api"` itself and dispatches under that origin;
 * a transport-level origin is purely informational and is NOT sent, because the
 * trust decision is made server-side. The `cli` origin the CLI passes to
 * `createLvisClient` labels the typed client only — it never crosses the wire.
 *
 * FAIL-CLOSED / NO-THROW: `dispatch` NEVER throws for a transport error. Every
 * failure path (network error, 401, unexpected status, malformed body) resolves
 * to a defined `{ ok: false, error: "<kebab-case-code>" }` envelope so the SDK
 * facade's uniform rejection handling applies. Fail-closed rejection codes from
 * the dispatcher (200/403 bodies) pass through verbatim.
 *
 * node 22+ global `fetch` — no new prod deps (a `fetchImpl` override exists only
 * for tests).
 */
import type {
  LocalApi,
  LocalApiErrorCode,
  LocalApiRequest,
  LocalApiResult,
} from "../api/local-api.js";
import {
  LOCAL_API_INFO_FILE,
  type LocalApiServerInfoFile,
} from "../main/local-api-server.js";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";

/** Feature namespace id — resolves to `~/.lvis/local-api/` (same as the server). */
const LOCAL_API_FEATURE = "local-api";

/**
 * Transport failure code: the loopback server could not be reached (connection
 * refused / network error) — the server is not listening, or went away mid-flight.
 */
export const CLI_SERVER_UNAVAILABLE = "server-unavailable";

/** Transport failure code: the Bearer secret was rejected by the server (HTTP 401). */
const CLI_UNAUTHORIZED = "unauthorized";

/** Transport failure code: an unexpected HTTP status with no usable envelope. */
const CLI_UNEXPECTED_RESPONSE = "unexpected-response";

/**
 * The CLI transport's failure-code union: the dispatcher's fail-closed codes
 * (passed through verbatim from 200/403 envelopes) plus the transport-layer
 * codes above. `LocalApiResult` is generic over this union, so the widened
 * codes are represented honestly — no casts at the transport boundary.
 */
export type CliTransportErrorCode =
  | LocalApiErrorCode
  | typeof CLI_SERVER_UNAVAILABLE
  | typeof CLI_UNAUTHORIZED
  | typeof CLI_UNEXPECTED_RESPONSE;

/** The discovery info the CLI needs to reach a running server. */
export interface CliConnection {
  /** The actual bound loopback port. */
  port: number;
  /** The per-boot bearer secret. */
  secret: string;
}

/**
 * Read the local API discovery file and return a {@link CliConnection}, or null
 * when the server is not running. The path + file shape come from the main
 * module ({@link LOCAL_API_INFO_FILE} + {@link LocalApiServerInfoFile}) and the
 * `openFeatureNamespace` helper — the SAME single source of truth the server
 * writes with — so a path/shape change can never drift between writer + reader.
 *
 * Null cases (server not running): missing/corrupt file (namespace read falls
 * back), or a tombstone (`port <= 0` or empty `secret`) written on shutdown.
 */
export async function readLocalApiConnection(): Promise<CliConnection | null> {
  const ns = openFeatureNamespace(LOCAL_API_FEATURE);
  // Fallback sentinel doubles as a tombstone: a missing/corrupt file reads back
  // as port 0 / empty secret and is treated exactly like an explicit tombstone.
  const info = await ns.readJson<LocalApiServerInfoFile>(LOCAL_API_INFO_FILE, {
    port: 0,
    secret: "",
    pid: 0,
  });
  // Bound the file-sourced port strictly (integer, valid TCP range) — the
  // request host is pinned to 127.0.0.1, so the port is the ONLY value the
  // discovery file contributes to the connection target.
  if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535 || info.secret.length === 0) {
    return null;
  }
  // Stale-after-crash detection: a crashed host never tombstones the file, so a
  // live-looking entry may point at a dead process. `kill(pid, 0)` probes
  // liveness without signalling (ESRCH → gone; EPERM → exists but foreign —
  // treat as alive, the connect attempt will fail closed anyway). Best-effort:
  // a recycled pid slips through and simply yields `server-unavailable`.
  if (info.pid > 0 && !isProcessAlive(info.pid)) {
    return null;
  }
  return { port: info.port, secret: info.secret };
}

/** Probe pid liveness via signal 0 (no signal is delivered). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = the process exists but belongs to another user — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wrap a {@link CliConnection} as a {@link LocalApi} that POSTs each dispatch to
 * the loopback `/v1/dispatch` endpoint with a Bearer secret. Implements the
 * `LocalApi` interface so `createLvisClient(httpApi, "cli")` yields the full
 * typed client without re-implementing it.
 *
 * The request body is `{ channel, args }` only (matching the server wire); the
 * `origin` on {@link LocalApiRequest} is dropped — the server owns the origin.
 *
 * `dispatch` NEVER throws for a transport error — it always resolves to a
 * defined success/failure envelope.
 */
export function createHttpLocalApi(
  conn: CliConnection,
  fetchImpl: typeof fetch = fetch,
): LocalApi<CliTransportErrorCode> {
  const endpoint = `http://127.0.0.1:${conn.port}/v1/dispatch`;

  async function dispatch(req: LocalApiRequest): Promise<LocalApiResult<CliTransportErrorCode>> {
    // Wire body is { channel, args } ONLY — the server injects origin itself.
    const body = JSON.stringify(
      req.args === undefined ? { channel: req.channel } : { channel: req.channel, args: req.args },
    );

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${conn.secret}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch {
      // Network-layer failure (connection refused / server gone) — never throw.
      return transportFailure(CLI_SERVER_UNAVAILABLE);
    }

    // 200 (success) and 403 (fail-closed rejection) both carry the exact
    // LocalApiResult JSON — pass it through verbatim. (A JSON-parse assertion
    // at the wire boundary, not a type-model cast.)
    if (response.status === 200 || response.status === 403) {
      try {
        return (await response.json()) as LocalApiResult<CliTransportErrorCode>;
      } catch {
        return transportFailure(CLI_UNEXPECTED_RESPONSE);
      }
    }

    // 401 → the secret was rejected. Mirror the server's kebab-case code.
    if (response.status === 401) {
      return transportFailure(CLI_UNAUTHORIZED);
    }

    // Any other status (400/404/405/413/500/…) has no usable success envelope.
    return transportFailure(CLI_UNEXPECTED_RESPONSE);
  }

  return { dispatch };
}

/**
 * Build a fail-closed transport envelope. `LocalApiResult` is generic over the
 * failure-code union, so the widened {@link CliTransportErrorCode} is
 * represented directly — no casts.
 */
function transportFailure(error: CliTransportErrorCode): LocalApiResult<CliTransportErrorCode> {
  return { ok: false, error };
}
