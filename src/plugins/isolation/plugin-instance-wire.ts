/**
 * The FORWARD direction of the boundary: the six host→plugin entry points
 * (`docs/blueprints/plugin-process-isolation.md` §2.1).
 *
 * `host-api-wire.ts` is the reverse channel — the 36 members a plugin calls on
 * the host. This is the other half: what the HOST calls on the plugin. They are
 * separate contracts with separate failure modes, which is why they are
 * separate modules and not one file called "the wire".
 *
 * Only FIVE of the six travel as methods declared here. The sixth —
 * `instance.handlers[tool](payload)` — travels as MCP `tools/call`, because the
 * child already serves a `PluginMcpServer` and inventing a second verb for the
 * one entry point that already has a protocol would mean two ways to invoke a
 * tool that could disagree about payloads, errors, and results.
 *
 * ELECTRON-FREE BY CONSTRUCTION, for the same reason `host-api-wire.ts` is: the
 * child imports this, and the child is a plain Node process.
 */
import type { PluginManifest } from "../types.js";
import type { PluginChildContext } from "./plugin-child-runtime.js";

/**
 * Wire format revision for the forward direction.
 *
 * Versioned INDEPENDENTLY of {@link HOST_API_WIRE_VERSION}: the two contracts
 * change for different reasons — a new hostApi member is not a new lifecycle
 * entry point — and a shared number would force a lockstep neither side needs.
 */
export const PLUGIN_INSTANCE_WIRE_VERSION = 1;

/**
 * The JSON-RPC methods the child answers besides MCP's own.
 *
 * Namespaced under `lvis/` so a method can never collide with an MCP method
 * name: the child routes on this prefix, and everything without it goes to the
 * `PluginMcpServer` untouched.
 */
export const PLUGIN_INSTANCE_METHODS = {
  /** Build the hostApi stub, load the factory, create the instance. Once. */
  construct: "lvis/instance/construct",
  start: "lvis/instance/start",
  onPublished: "lvis/instance/onPublished",
  stop: "lvis/instance/stop",
  readUiResource: "lvis/instance/readUiResource",
} as const;

/** One of the five. */
export type PluginInstanceMethod =
  (typeof PLUGIN_INSTANCE_METHODS)[keyof typeof PLUGIN_INSTANCE_METHODS];

/** Whether `method` is served by the child's instance handler rather than MCP. */
export function isPluginInstanceMethod(method: string): method is PluginInstanceMethod {
  return method.startsWith("lvis/instance/");
}

/**
 * What `construct` carries.
 *
 * The manifest crosses whole rather than being re-derived in the child from
 * `plugin.json` on disk. Re-reading it there would put a SECOND parse of the
 * security-relevant document behind the boundary, where the host's integrity
 * verification does not reach — the child would then be serving a manifest the
 * host never checked.
 */
export interface PluginConstructParams {
  readonly wire: typeof PLUGIN_INSTANCE_WIRE_VERSION;
  readonly manifest: PluginManifest;
  readonly context: PluginChildContext;
  /** Absolute path of the plugin entry module the child imports. */
  readonly entryPath: string;
  /**
   * The declared tool names whose handlers the instance MUST expose.
   *
   * Reported back by {@link PluginConstructResult} so the host learns which of
   * them the plugin actually implemented, exactly as `buildMethodMap` learns it
   * in-process. Sending the expectation rather than asking for the whole
   * handler map keeps the answer a set of declared names — a child cannot
   * announce a tool its manifest never declared.
   */
  readonly declaredToolNames: readonly string[];
}

/** What `construct` answers. */
export interface PluginConstructResult {
  readonly wire: typeof PLUGIN_INSTANCE_WIRE_VERSION;
  /** The subset of `declaredToolNames` the instance exposes a handler for. */
  readonly implementedToolNames: readonly string[];
  /** Whether the instance implements the optional `readUiResource`. */
  readonly servesUiResources: boolean;
  /** Which of `start` / `onPublished` / `stop` the instance implements. */
  readonly lifecycleHooks: readonly PluginLifecycleHookName[];
}

/** The optional lifecycle hooks a `RuntimePlugin` may implement. */
export type PluginLifecycleHookName = "start" | "onPublished" | "stop";

/** What `readUiResource` carries. */
export interface ReadUiResourceParams {
  readonly uri: string;
}

/** What `readUiResource` answers. */
export interface ReadUiResourceResult {
  readonly html: string;
}
