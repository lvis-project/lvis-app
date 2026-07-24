/**
 * Plugin Lifecycle Log — structured debug logging for the plugin subsystem.
 *
 * Prefer `plog()` for all new plugin lifecycle logs so entries share a
 * consistent shape: `{ pluginId, phase, ...ctx }`. This lets a single
 *
 *   grep '"phase":"lifecycle:restart' ~/.lvis/logs/main.jsonl
 *
 * reveal the full restart trace across the plugin subsystem. Legacy direct
 * `log.info/warn/error` calls in the plugin area will be migrated to `plog()`
 * incrementally; new code MUST use `plog()` from the outset.
 *
 * Why this exists:
 *   The plugin area absorbed 50+ patches in 24h with repeated regressions
 *   ("fixed → broken → fixed → broken"). Untyped ad-hoc log strings made it
 *   impossible to grep the lifecycle of a single plugin from logs alone.
 *   This module normalises the contract so future regressions can be located
 *   from logs without re-deriving the call graph.
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugin-lifecycle");

/**
 * Phase labels used as the structured `phase` field on every plugin log line.
 *
 * Granularity policy: every state transition that has been observed to fail
 * independently must be its own phase. If two transitions share a single
 * phase label, a future regression in one will be indistinguishable from a
 * regression in the other when reading the log stream.
 *
 * Naming convention: `"lifecycle:<area>[:<sub>]:<verb>"`
 *   - area:  discovery | validation | load | register | start | invoke |
 *            event | webview | restart | stop | capability
 *   - sub:   optional sub-area (e.g. `tool` under `register`;
 *            `stop`, `reload`, `start` under `restart`; `load` under `webview`)
 *   - verb:  start | ok | fail | skip | retry | timeout
 *     (use `start` for entry, `ok` for success, `fail` for caught error,
 *      `skip` for silent decision branches that previously had no log)
 *
 * Example: "lifecycle:restart:stop:fail" means "restart hit an error while
 * trying to stop the previous instance" (area=restart, sub=stop, verb=fail).
 */
export const PluginPhase = {
  // discovery — registry hydrate, manifest path resolution
  DISCOVERY_START: "lifecycle:discovery:start",
  DISCOVERY_OK: "lifecycle:discovery:ok",
  DISCOVERY_SKIP: "lifecycle:discovery:skip",
  DISCOVERY_FAIL: "lifecycle:discovery:fail",

  // validation — manifest schema/version/signature
  VALIDATION_START: "lifecycle:validation:start",
  VALIDATION_OK: "lifecycle:validation:ok",
  VALIDATION_FAIL: "lifecycle:validation:fail",

  // load — module import + createPlugin invocation
  LOAD_START: "lifecycle:load:start",
  LOAD_OK: "lifecycle:load:ok",
  LOAD_FAIL: "lifecycle:load:fail",

  // register — tool/event registration
  REGISTER_TOOL_OK: "lifecycle:register:tool:ok",
  REGISTER_TOOL_SKIP: "lifecycle:register:tool:skip",
  REGISTER_TOOL_FAIL: "lifecycle:register:tool:fail",

  // start — instance.start()
  START_OK: "lifecycle:start:ok",
  START_FAIL: "lifecycle:start:fail",
  START_SLOW: "lifecycle:start:slow",

  // invoke — tool handler invocation
  INVOKE_START: "lifecycle:invoke:start",
  INVOKE_OK: "lifecycle:invoke:ok",
  INVOKE_FAIL: "lifecycle:invoke:fail",

  // event — emit / onEvent
  EVENT_EMIT: "lifecycle:event:emit",
  EVENT_LISTEN: "lifecycle:event:listen",
  EVENT_FAIL: "lifecycle:event:fail",

  // webview — UI bootstrap
  WEBVIEW_REGISTER: "lifecycle:webview:register",
  WEBVIEW_ATTACH: "lifecycle:webview:attach",
  WEBVIEW_REJECT: "lifecycle:webview:reject",
  WEBVIEW_LOAD_OK: "lifecycle:webview:load:ok",
  WEBVIEW_LOAD_FAIL: "lifecycle:webview:load:fail",

  // restart — hot reload
  RESTART_REQUEST: "lifecycle:restart:request",
  RESTART_STOP_FAIL: "lifecycle:restart:stop:fail",
  RESTART_RELOAD_OK: "lifecycle:restart:reload:ok",
  RESTART_RELOAD_FAIL: "lifecycle:restart:reload:fail",
  RESTART_START_OK: "lifecycle:restart:start:ok",
  RESTART_START_FAIL: "lifecycle:restart:start:fail",

  // stop — shutdown
  STOP_OK: "lifecycle:stop:ok",
  STOP_FAIL: "lifecycle:stop:fail",

  // capability — check / deny
  CAPABILITY_CHECK: "lifecycle:capability:check",
  CAPABILITY_DENY: "lifecycle:capability:deny",
} as const;

export type PluginPhaseValue = (typeof PluginPhase)[keyof typeof PluginPhase];

/**
 * Required + optional structured fields on every plugin log line.
 *
 * `pluginId` and `phase` are mandatory — without them the log entry cannot be
 * correlated to a lifecycle trace. `reason` is strongly recommended on every
 * `:fail` / `:skip` phase so the branch decision is visible in the log
 * without having to read the source.
 */
export interface PluginLogContext {
  pluginId: string;
  phase: PluginPhaseValue;
  /** Tool name when the log relates to a specific tool invocation. */
  toolName?: string;
  /** Event type when the log relates to emit / onEvent. */
  eventType?: string;
  /** Branch decision reason on `:skip` / `:fail` phases (e.g. "manifest_missing", "duplicate_tool"). */
  reason?: string;
  /** Caught error — pino preserves stack via the `err` serializer. */
  err?: unknown;
  /** Additional ad-hoc fields (entryUrl, version, capability, etc.). */
  [key: string]: unknown;
}

/**
 * Emit a structured plugin lifecycle log entry. Always prefer this over
 * raw `log.debug(...)` inside the plugin subsystem.
 *
 * Level policy:
 *   - debug: routine state transitions (`*:start`, `*:ok`)
 *   - info:  user-visible lifecycle milestones (load complete, restart triggered)
 *   - warn:  recoverable skip / fallback branches
 *   - error: caught failures that mark the plugin as failed
 */
export function plog(
  level: "debug" | "info" | "warn" | "error",
  ctx: PluginLogContext,
  msg: string,
): void {
  log[level](ctx, msg);
}
