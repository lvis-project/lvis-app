import { createHash } from "node:crypto";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";
import type { McpServerApproval, McpServerConfig } from "./types.js";
import { anchorBundledCommand } from "../plugins/plugin-bundled-command.js";
import { PluginContributionTrustStore } from "../plugins/plugin-contribution-trust.js";

export interface PluginMcpOwner {
  pluginId: string;
  pluginVersion: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

export interface PreparedPluginMcpProjection {
  owner: PluginMcpOwner;
  serverId: string;
  config: McpServerConfig;
  approval: McpServerApproval;
}

/** Exact static-descriptor approval. A new generation may restore identical bytes. */
export class PluginMcpTrustStore {
  private readonly store: PluginContributionTrustStore;

  constructor(path?: string) {
    this.store = new PluginContributionTrustStore("mcpServer", path);
  }

  approve(projection: PreparedPluginMcpProjection): void {
    this.store.approve(projection.owner);
  }

  isApproved(projection: PreparedPluginMcpProjection): boolean {
    return this.store.isApproved(projection.owner);
  }

  revoke(projection: PreparedPluginMcpProjection): void {
    this.store.revoke(projection.owner);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || /[\u0000\r\n]/.test(entry))) {
    throw new Error(`${label} must be an array of strings without control characters`);
  }
}

function assertStringRecord(value: unknown, label: string): asserts value is Record<string, string> {
  assertRecord(value, label);
  if (Object.entries(value).some(([key, entry]) => !key || typeof entry !== "string" || /[\u0000\r\n]/.test(key) || /[\u0000]/.test(entry))) {
    throw new Error(`${label} must contain only string keys and values without NUL characters`);
  }
}

function parseStaticConfig(raw: unknown, label: string): Omit<McpServerConfig, "id"> {
  assertRecord(raw, label);
  const allowed = new Set([
    "transport", "command", "args", "env", "url", "oauth", "headers", "auth", "apiKeyEnv", "apiKeyHeader",
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  if (raw.transport !== "stdio" && raw.transport !== "http") {
    throw new Error(`${label}.transport must be 'stdio' or 'http'`);
  }
  if (raw.auth !== undefined && !["none", "api-key", "oauth", "sso"].includes(String(raw.auth))) {
    throw new Error(`${label}.auth is invalid`);
  }
  if (raw.transport === "stdio") {
    assertString(raw.command, `${label}.command`);
    if (raw.args !== undefined) assertStringArray(raw.args, `${label}.args`);
    if (raw.env !== undefined) assertStringRecord(raw.env, `${label}.env`);
    if (raw.apiKeyEnv !== undefined) assertString(raw.apiKeyEnv, `${label}.apiKeyEnv`);
    if (raw.url !== undefined || raw.headers !== undefined || raw.apiKeyHeader !== undefined || raw.oauth !== undefined) {
      throw new Error(`${label} mixes stdio and HTTP fields`);
    }
  } else {
    assertString(raw.url, `${label}.url`);
    let parsed: URL;
    try { parsed = new URL(raw.url); } catch { throw new Error(`${label}.url must be an absolute URL`); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${label}.url must use http or https`);
    }
    if (raw.headers !== undefined) assertStringRecord(raw.headers, `${label}.headers`);
    if (raw.apiKeyHeader !== undefined) assertString(raw.apiKeyHeader, `${label}.apiKeyHeader`);
    if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.apiKeyEnv !== undefined) {
      throw new Error(`${label} mixes HTTP and stdio fields`);
    }
    if (raw.oauth !== undefined) assertRecord(raw.oauth, `${label}.oauth`);
  }
  return Object.freeze({ ...raw }) as Omit<McpServerConfig, "id">;
}

function safePrefix(owner: PluginMcpOwner): string {
  return `${owner.pluginId}_${owner.localId}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
}

function buildProjection(owner: PluginMcpOwner, raw: unknown): PreparedPluginMcpProjection {
  const configWithoutId = parseStaticConfig(raw, `plugin MCP '${owner.localId}'`);
  const identityHash = createHash("sha256")
    .update([owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("\0"))
    .digest("hex")
    .slice(0, 24);
  const serverId = `plugin_${identityHash}`;
  const config = Object.freeze({ ...configWithoutId, id: serverId }) as McpServerConfig;
  const requiredAuth = config.auth ?? "none";
  const approval: McpServerApproval = {
    id: serverId,
    name: `${owner.pluginId}:${owner.localId}`,
    status: "approved",
    transport: config.transport,
    ...(config.transport === "stdio" ? { allowedCommands: [config.command] } : { allowedUrls: [new URL(config.url).hostname] }),
    requiredAuth,
    ...(config.transport === "stdio" && config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.transport === "http" && config.apiKeyHeader ? { apiKeyHeader: config.apiKeyHeader } : {}),
    tlsRequired: config.transport === "http" && config.url.startsWith("https://"),
    allowedCapabilities: ["tools"],
    maxTools: 64,
    toolNamePrefix: safePrefix(owner),
    toolPermissionMode: "strict",
    connectionTimeoutMs: 30_000,
    maxConcurrentRequests: 4,
  };
  return Object.freeze({ owner: Object.freeze(owner), serverId, config, approval: Object.freeze(approval) });
}

/** Static parse/fingerprint preparation. It performs no spawn, network, discovery, or registration. */
export function preparePluginMcpGeneration(
  generation: ActivePluginGeneration,
  payloadRoot = process.cwd(),
): readonly PreparedPluginMcpProjection[] {
  const projections: PreparedPluginMcpProjection[] = [];
  for (const contribution of generation.contributions) {
    if (contribution.kind !== "mcpServer") continue;
    if (contribution.files.length !== 1) {
      throw new Error(`plugin MCP '${contribution.localId}' must materialize exactly one descriptor file`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contribution.files[0].content) as unknown;
    } catch (error) {
      throw new Error(`plugin MCP '${contribution.localId}' is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = parseStaticConfig(raw, `plugin MCP '${contribution.localId}'`);
    let fingerprint = contribution.fingerprint;
    let preparedRaw: unknown = raw;
    if (parsed.transport === "stdio") {
      const anchored = anchorBundledCommand(
        payloadRoot,
        contribution.path,
        [parsed.command!, ...(parsed.args ?? [])],
        contribution.fingerprint,
        `plugin MCP '${contribution.localId}'`,
      );
      fingerprint = anchored.fingerprint;
      preparedRaw = {
        ...(raw as Record<string, unknown>),
        command: anchored.command[0]!,
        args: anchored.command.slice(1),
      };
    }
    projections.push(buildProjection({
      pluginId: generation.pluginId,
      pluginVersion: generation.pluginVersion,
      generationId: generation.generationId,
      localId: contribution.localId,
      fingerprint,
    }, preparedRaw));
  }
  return Object.freeze(projections);
}
