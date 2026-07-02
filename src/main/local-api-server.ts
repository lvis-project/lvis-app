/**
 * local-api-server.ts — #1436 lifecycle wiring for the loopback local API.
 *
 * This module owns the MAIN-PROCESS lifecycle of the #1409 external surface:
 * it decides whether to start the loopback HTTP+SSE server (opt-in gate),
 * generates a fresh per-boot bearer secret, builds the same `IpcDeps` the IPC
 * registrars receive plus a server-owned {@link ChatSendContext}, starts the
 * transport (`src/api/http-server.ts`), and persists a small discovery file so
 * a CLI companion can find the port + secret. It also tears everything down on
 * app shutdown.
 *
 * SECURITY / GATE:
 *   - The server is OFF by default. It starts ONLY when the user enabled it in
 *     Settings (`system.localApiServer === true`) OR the environment sets
 *     `LVIS_LOCAL_API=1`. When the gate is off, {@link maybeStartLocalApiServer}
 *     returns null immediately — no listener socket is opened and nothing is
 *     written to disk.
 *   - The secret is `randomBytes(32).toString("hex")` (64 hex chars), fresh per
 *     boot. It is NEVER logged. The bearer check + constant-time compare live in
 *     the transport (`http-server.ts`).
 *   - The discovery file is written through {@link openFeatureNamespace}
 *     (`~/.lvis/local-api/`) with 0o600 file mode. That mode IS the protection
 *     model for this local capability token — same posture as an SSH private
 *     key: any local process running as the same user could read it, so the file
 *     is only as strong as the OS user boundary. This is intentional and matches
 *     the loopback trust model.
 *
 * STORAGE DISCIPLINE (project CLAUDE.md): `openFeatureNamespace` is the ONLY
 * write path into `~/.lvis/local-api/` — this module never touches `fs`
 * directly, so the 0o700 dir / 0o600 file / atomic-write contract cannot drift.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot.js";
import type { SettingsService } from "../data/settings-store.js";
import type { IpcDeps } from "../ipc/types.js";
import type { ChatSendContext } from "../ipc/handlers/chat.js";
import type { TurnResult } from "../engine/conversation-loop.js";
import { createLocalApi, type ExternalMutationApprover } from "../api/local-api.js";
import { startLocalApiHttpServer, type LocalApiHttpServer } from "../api/http-server.js";
import { createStreamBroadcaster } from "../api/stream-broadcaster.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("local-api");

/** Feature namespace id — resolves to `~/.lvis/local-api/`. */
const LOCAL_API_FEATURE = "local-api";

/** The discovery file the CLI reads to find the running server. */
export const LOCAL_API_INFO_FILE = "server.json";

/**
 * Discovery info persisted after the server is listening. `secret` is a local
 * capability token protected only by the 0o600 file mode (see module doc) —
 * treat it exactly like an SSH private key.
 */
export interface LocalApiServerInfoFile {
  /** The actual bound loopback port (ephemeral; never 0 once listening). */
  port: number;
  /** Per-boot bearer secret (64 hex chars). NEVER logged. */
  secret: string;
  /** The main-process pid, so a CLI can detect a stale file after a crash. */
  pid: number;
}

/**
 * Tombstone written on stop: a stale secret + port must NEVER linger on disk
 * after the server is gone. We overwrite (rather than delete) because
 * {@link openFeatureNamespace} exposes only an atomic `writeJson`; a blanked
 * file is unambiguously "no server" for a reader and keeps the single-writer
 * atomic-write contract intact.
 */
const LOCAL_API_TOMBSTONE: LocalApiServerInfoFile = { port: 0, secret: "", pid: 0 };

/** Module-level handle to the running server (C17 shared-handle pattern). */
let runningServer: LocalApiHttpServer | null = null;

/**
 * Is the opt-in local API server enabled? True when the user turned it on in
 * Settings OR the environment sets `LVIS_LOCAL_API=1`. Fail-closed: anything
 * else (undefined flag, malformed env) is OFF.
 */
export function isLocalApiEnabled(
  settingsService: SettingsService,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settingEnabled = settingsService.get("system").localApiServer === true;
  const envEnabled = env.LVIS_LOCAL_API === "1";
  return settingEnabled || envEnabled;
}

/**
 * Build the server-owned {@link ChatSendContext}. Mirrors the registrar-owned
 * state in `src/ipc/domains/chat.ts` (nextStreamId allocator + in-flight turn
 * tracker) but scoped to this transport: the sink is the broadcaster's fan-out
 * so SSE subscribers receive the exact same frames the renderer would.
 */
function buildChatSendContext(sink: ChatSendContext["sink"]): ChatSendContext {
  let nextStreamId = 0;
  const allocateStreamId = () => ++nextStreamId;
  let activeStreamTurn: Promise<TurnResult> | null = null;
  const trackStreamTurn = (factory: () => Promise<TurnResult>) => {
    const turnPromise = factory().finally(() => {
      if (activeStreamTurn === turnPromise) activeStreamTurn = null;
    });
    activeStreamTurn = turnPromise;
    return turnPromise;
  };
  return { sink, allocateStreamId, trackStreamTurn };
}

/**
 * Build the #1409 approval-mediated external-mutation approver over the live
 * {@link ApprovalGate}. Returns `undefined` when no gate is available (boot
 * without a conversation surface) — the dispatcher then keeps its byte-identical
 * fail-closed default (gesture-gated channels rejected).
 *
 * The request MIRRORS the existing agent-action call sites (work-board-engine /
 * agent-action-requester): `category: "agent-action"`, `toolName: <channel>`,
 * `toolCategory: "meta"`, a fresh `randomUUID()` id, `createdAt: Date.now()`, and
 * `trustOrigin: <external origin>`. The `reason` is renderer-facing Korean per
 * the IPC-language convention. `requireExplicit` is NOT (and CANNOT be) passed
 * here — the gate's signature is `Omit<ApprovalRequest, "requireExplicit">` and
 * it derives `requireExplicit` from the active policy
 * (`PolicyFile.requireExplicitApproval`). The gate ALWAYS shows this modal
 * because the request is an `agent-action` (its `isReadOnly` short-circuit
 * explicitly excludes `kind === "agent-action"`, so it is never auto-approved).
 * We only ever treat an `allow-*` choice as approval and NEVER persist an
 * allow-always exception for this path — the caller reads only `.choice` and
 * drops `rememberPattern`, so even an `allow-always` click grants exactly this
 * one mutation and nothing durable.
 *
 * Fail-closed: any error/timeout inside `requestAndWait` (the gate resolves
 * `deny-once` on timeout / send-failure) is treated as DENIED; a thrown error is
 * caught, logged (English, no secrets), and returned as `false`.
 */
export function buildExternalMutationApprover(
  approvalGate: ApprovalGate | undefined,
  emit: (message: string) => void,
): ExternalMutationApprover | undefined {
  if (!approvalGate) return undefined;
  return async ({ channel, args, origin }) => {
    try {
      const decision = await approvalGate.requestAndWait({
        id: randomUUID(),
        category: "agent-action",
        kind: "agent-action",
        toolName: channel,
        toolCategory: "meta",
        args,
        reason: "외부 CLI/API가 권한 모드 변경을 요청했습니다. 허용하시겠습니까?",
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin: origin,
      });
      // Mirror the agent-action call sites: only an `allow-*` choice approves;
      // deny-once / deny-always (and the gate's timeout/send-failure deny-once)
      // are all rejections. rememberPattern is ignored — no persisted grant.
      return decision.choice.startsWith("allow");
    } catch (err) {
      // Fail-closed: an unexpected gate throw is a denial. One English line, no
      // secrets (channel + origin only).
      emit(
        `[local-api] external-mutation approval errored channel=${channel} origin=${origin}: ${
          err instanceof Error ? err.message : String(err)
        } → denied`,
      );
      return false;
    }
  };
}

/**
 * Start the loopback local API server IFF the gate is on. Returns `{ port }` on
 * success, or `null` when the gate is off (no socket, no disk write).
 *
 * Idempotent-ish: if a server is already running it is returned as-is rather
 * than double-started (defensive — main.ts calls this exactly once).
 */
export async function maybeStartLocalApiServer(input: {
  services: AppServices;
  getMainWindow: () => BrowserWindow | null;
  getAppWindows: () => Array<BrowserWindow | null | undefined>;
  log?: (message: string) => void;
}): Promise<{ port: number } | null> {
  const { services, getMainWindow, getAppWindows } = input;
  const emit = input.log ?? ((m: string) => log.info(m));

  if (!isLocalApiEnabled(services.settingsService)) {
    return null;
  }
  if (runningServer) {
    return { port: runningServer.port };
  }

  // Same DI bag the IPC registrars receive (see registerIpcHandlers).
  const ipc: IpcDeps = { ...services, getMainWindow, getAppWindows };

  // Server-owned stream plumbing: the broadcaster's sink fans `chat send`
  // frames out to every SSE subscriber (byte-identical to the renderer's).
  const broadcaster = createStreamBroadcaster();
  const chatSendContext = buildChatSendContext(broadcaster.sink);

  // #1409 approval-mediated external-mutation gate. Undefined when no
  // ApprovalGate is available → the dispatcher keeps its fail-closed default.
  const externalMutationApprover = buildExternalMutationApprover(services.approvalGate, emit);

  const api = createLocalApi({ ipc, chatSendContext, externalMutationApprover });

  // Fresh per-boot bearer secret (64 hex chars). Never logged.
  const secret = randomBytes(32).toString("hex");

  // Port 0 → OS-assigned ephemeral loopback port; the actual value is read back.
  const server = await startLocalApiHttpServer({
    api,
    secret,
    broadcaster,
    // Do NOT forward the secret into the transport log — startLocalApiHttpServer
    // is documented to never receive it, and this callback only sees benign
    // dispatch/routing diagnostics.
    log: (message: string) => emit(`[local-api] ${message}`),
  });
  runningServer = server;

  // Persist discovery info AFTER listen succeeds so the file never points at a
  // dead port for this boot. 0o600 file mode (via openFeatureNamespace) is the
  // protection model for this capability token — same as an SSH key.
  const info: LocalApiServerInfoFile = { port: server.port, secret, pid: process.pid };
  await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, info);

  emit(`[local-api] listening on 127.0.0.1:${server.port}`);
  return { port: server.port };
}

/**
 * Stop the local API server and blank its discovery file. Idempotent — safe to
 * call when nothing is running (e.g. the gate was off this boot, or a double
 * shutdown). Fast: the transport's close() destroys idle sockets and ends live
 * SSE streams so it never hangs.
 */
export async function stopLocalApiServer(): Promise<void> {
  const server = runningServer;
  runningServer = null;
  if (server) {
    await server.close();
    // Overwrite the discovery file with a tombstone so a stale secret + port
    // never lingers on disk after the server is gone. Best-effort — a failed
    // blank must not throw out of the shutdown sequence.
    try {
      await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, LOCAL_API_TOMBSTONE);
    } catch (err) {
      log.warn("failed to blank local-api discovery file: %s", err instanceof Error ? err.message : String(err));
    }
  }
}
