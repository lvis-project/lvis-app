



import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  McpCapability,
  McpGovernancePolicy,
  McpServerApproval,
  McpServerConfig,
  McpToolSchema,
  ValidationResult,
} from "./types.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  ENV_NAME_RE,
  HTTP_HEADER_NAME_RE,
  MAX_NAME_LEN,
  RESERVED_ENV_NAMES,
  RESERVED_HEADERS,
} from "./safe-names.js";
import { t } from "../i18n/index.js";
const log = createLogger("mcp-governance");

/**
 * The methods each {@link McpCapability} covers (design §3.6,
 * `governance-per-request`). `satisfies Record<McpCapability, string[]>` makes
 * this exhaustive: adding a capability to the enum forces listing its methods
 * here (build error otherwise), closing the enum↔gate SOT drift. Tasks methods
 * ride `tools` (they manage long-running `tools/call` work).
 */
const CAPABILITY_METHODS = {
  tools: ["tools/list", "tools/call", "tasks/get", "tasks/update", "tasks/cancel"],
  resources: [
    "resources/list",
    "resources/read",
    "resources/templates/list",
    "resources/subscribe",
    "resources/unsubscribe",
  ],
  prompts: ["prompts/list", "prompts/get"],
} satisfies Record<McpCapability, string[]>;

/** Inverted method → capability lookup, derived from {@link CAPABILITY_METHODS}. */
const REQUEST_METHOD_CAPABILITY: Record<string, McpCapability> = Object.fromEntries(
  Object.entries(CAPABILITY_METHODS).flatMap(([capability, methods]) =>
    methods.map((method) => [method, capability as McpCapability]),
  ),
);

/**
 * Protocol/control methods that exercise NO gated capability — discovery, the
 * dual-era handshake, liveness, and notifications. This is a CLOSED allowlist:
 * everything NOT here and NOT in {@link REQUEST_METHOD_CAPABILITY} is denied
 * (fail-closed), so a new capability verb a server invokes is denied until it is
 * explicitly classified — rather than sailing through ungated.
 */
const CONTROL_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "initialize",
  "ping",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
]);

/** MCP Apps (`io.modelcontextprotocol/ui`) resource scheme — an EXTENSION, not the core `resources` capability. */
const MCP_APPS_UI_SCHEME = "ui://";

const DEFAULT_POLICY: McpGovernancePolicy = {
  version: "1.0",
  defaultPolicy: "deny",
  servers: [],
  globalRules: {
    maxServersTotal: 10,
    blockedUrlPatterns: ["*.ngrok.io", "*.serveo.net", "*.localtunnel.me"],
    allowedUrlPatterns: [],
    policyRefreshIntervalMs: 30 * 60 * 1000,
  },
};

export class McpGovernance {
  private policy: McpGovernancePolicy;
  private runtimeApprovals: Map<string, McpServerApproval>;
  private readonly policyPath: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    policyPath?: string,
    scopedState?: {
      policy: McpGovernancePolicy;
      runtimeApprovals: Map<string, McpServerApproval>;
    },
  ) {
    this.policyPath = policyPath ?? join(lvisHome(), "governance", "mcp-policy.json");
    this.policy = scopedState?.policy ?? this.loadPolicy();
    this.runtimeApprovals = scopedState?.runtimeApprovals ?? new Map();
  }



  private loadPolicy(): McpGovernancePolicy {
    if (!existsSync(this.policyPath)) {
      log.info("Policy file missing — applying deny-by-default");
      return DEFAULT_POLICY;
    }
    try {
      const raw = readFileSync(this.policyPath, "utf-8");
      const parsed = JSON.parse(raw) as McpGovernancePolicy;


      if (parsed.defaultPolicy !== "deny") {
      log.warn("defaultPolicy must be 'deny'. Forcing deny-by-default.");
        parsed.defaultPolicy = "deny";
      }
      if (!parsed.globalRules) parsed.globalRules = DEFAULT_POLICY.globalRules;
      if (!Array.isArray(parsed.servers)) parsed.servers = [];

    log.info(`Policy loaded: ${parsed.servers.length} server rules`);
      return parsed;
    } catch (err) {
    log.error({ err }, "Policy file parse failed — applying deny-by-default");
      return DEFAULT_POLICY;
    }
  }

  /** Start periodic policy refresh so IT-admin updates take effect. */
  startPolicyRefresh(onRevoked?: (revokedIds: string[]) => void | Promise<void>): void {
    if (this.refreshTimer) return;
    const interval = this.policy.globalRules.policyRefreshIntervalMs;
    this.refreshTimer = setInterval(() => {
      const previous = this.policy;
      const updated = this.loadPolicy();
      const prevStatusById = new Map(previous.servers.map((server) => [server.id, server.status]));
      const revokedIds = updated.servers
        .filter((s) => s.status === "revoked")
        .filter((s) => prevStatusById.get(s.id) !== "revoked")
        .map((s) => s.id);
      this.policy = updated;
      if (revokedIds.length > 0) {
    log.warn(`Revoked servers detected: ${revokedIds.join(", ")}`);
        Promise.resolve(onRevoked?.(revokedIds)).catch((err) => {
      log.error("revoke callback failed: %s", err);
        });
      }
    }, interval);
    this.refreshTimer.unref?.();
  }

  stopPolicyRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ─── Layer 1: Server Install Validation ─────────────────────

  /**
   * Validate a server config against policy.
   * Returns the layer that blocked the request when validation fails.
   */
  validateServer(config: McpServerConfig): ValidationResult {
    // L0: policy presence
    if (!this.policy) {
      return { valid: false, reason: t("be_mcpGovernance.policyNotLoaded"), layer: 0 };
    }

    // L1-a: server approval state (deny-by-default)
    const approval = this.findApproval(config.id);
    if (!approval) {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServer", { id: config.id }), layer: 1 };
    }
    if (approval.status === "revoked") {
      return { valid: false, reason: t("be_mcpGovernance.revokedServer", { id: config.id, revokedAt: approval.revokedAt ?? "" }), layer: 1 };
    }
    if (approval.status === "pending") {
      return { valid: false, reason: t("be_mcpGovernance.pendingServer", { id: config.id }), layer: 1 };
    }

    // L1-b: global server count limit
    const activeCount = this.policy.servers.filter((s) => s.status === "approved").length + this.runtimeApprovals.size;
    if (activeCount > this.policy.globalRules.maxServersTotal) {
      return { valid: false, reason: t("be_mcpGovernance.maxServersExceeded", { activeCount, maxServersTotal: this.policy.globalRules.maxServersTotal }), layer: 1 };
    }

    // L1-c: transport validation
    if (config.transport !== approval.transport) {
      return { valid: false, reason: t("be_mcpGovernance.transportMismatch", { configTransport: config.transport, approvedTransport: approval.transport }), layer: 1 };
    }

    // L1-d: stdio command validation
    if (config.transport === "stdio") {
      const cmdResult = this.validateStdioCommand(config, approval);
      if (!cmdResult.valid) return cmdResult;
      const apiKeyEnvResult = this.validateApiKeyEnv(config, approval);
      if (!apiKeyEnvResult.valid) return apiKeyEnvResult;
    }

    // L1-e: HTTP / SSE / WebSocket URL validation
    if (
      config.transport === "http" ||
      config.transport === "sse" ||
      config.transport === "websocket"
    ) {
      const urlResult = this.validateUrl(config, approval);
      if (!urlResult.valid) return urlResult;

      // L1-f: Streamable HTTP only — enforce HTTPS except localhost/loopback.
      //       Private-network IP checks are delegated to NetworkGuard (Tier A2).
      if (config.transport === "http") {
        const httpResult = this.validateHttpScheme(config.url);
        if (!httpResult.valid) return httpResult;

        // L1-g: Streamable HTTP headers must not smuggle CRLF. Even though
        //       admin governance is trusted, request-splitting via header
        //       values with \r or \n is cheap to block here.
        const headersResult = this.validateHeaders(config.headers);
        if (!headersResult.valid) return headersResult;
        const apiKeyHeaderResult = this.validateApiKeyHeader(config, approval);
        if (!apiKeyHeaderResult.valid) return apiKeyHeaderResult;

        // L1-h: `allowPrivateNetworks` is a per-server escape hatch — it
        //       must be authorised by admin policy, either globally or on
        //       the matching approval. Otherwise any config file could
        //       self-elevate out of NetworkGuard.
        if (config.allowPrivateNetworks) {
          const gateResult = this.validateAllowPrivateNetworks(approval);
          if (!gateResult.valid) return gateResult;
        }
      }
    }

    // L2: connection security validation
    const connResult = this.validateConnectionSecurity(config, approval);
    if (!connResult.valid) return connResult;

    return { valid: true };
  }

  // ─── Layer 3: Tool Registration Validation ─────────────────────

  /**
   * Validate tool schemas an MCP server wants to register.
   * - Enforce namespace: mcp_{prefix}_{toolName}
   * - Prevent existing tool shadowing
   * - Enforce max tool count
   */
  validateToolRegistration(
    serverId: string,
    tools: McpToolSchema[],
    existingToolNames: Set<string>,
  ): ValidationResult {
    const approval = this.findApproval(serverId);
    if (!approval || approval.status !== "approved") {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServerToolRegistration", { serverId }), layer: 3 };
    }

    // Capability gate: whether tools are allowed.
    if (!approval.allowedCapabilities.includes("tools")) {
      return { valid: false, reason: t("be_mcpGovernance.noToolRegistrationPermission", { serverId }), layer: 3 };
    }

    // Max tool count.
    if (tools.length > approval.maxTools) {
      return { valid: false, reason: t("be_mcpGovernance.toolCountExceeded", { toolCount: tools.length, maxTools: approval.maxTools, serverId }), layer: 3 };
    }

    // Namespace and shadowing validation.
    const requiredPrefix = `mcp_${approval.toolNamePrefix}_`;
    for (const tool of tools) {
      // Namespace enforcement.
      const namespacedName = tool.name.startsWith(requiredPrefix)
        ? tool.name
        : `${requiredPrefix}${tool.name}`;

      // Prevent existing tool shadowing.
      if (existingToolNames.has(namespacedName)) {
        return { valid: false, reason: t("be_mcpGovernance.toolNameConflict", { namespacedName }), layer: 3 };
      }

      // Block builtin/plugin tool shadowing.
      const baseNames = [
        "agent_list",
        "agent_spawn",
        "ask_user_question",
        "document_list",
        "document_page_content",
        "document_structure",
        "knowledge_search",
        "render_html",
        "request_plugin",
        "routine_schedule",
        "skill_list",
        "skill_load",
        "todo_session_write",
        "web_fetch",
        "web_search",
      ];
      if (baseNames.includes(tool.name)) {
        return { valid: false, reason: t("be_mcpGovernance.builtinToolOverwriteBlocked", { toolName: tool.name }), layer: 3 };
      }
    }

    return { valid: true };
  }

  /**
   * Per-request capability gate (milestone `governance-per-request`, design §3.6).
   *
   * Where {@link validateToolRegistration} gates ONCE at connect time on the
   * static `allowedCapabilities` whitelist, this gates EVERY request on the
   * capability that request actually exercises (a `tools/call` exercises
   * `tools`, a `resources/read` exercises `resources`, …). Keeps the same
   * deny-by-default + approved-server invariants: an unapproved server is denied,
   * and a request exercising a capability the server was not approved for is
   * denied — even if a prior registration slipped through. Protocol/control
   * methods that exercise NO gated capability (`server/discover`, `ping`,
   * notifications) pass.
   */
  validateRequestCapability(
    serverId: string,
    method: string,
    params?: Record<string, unknown>,
  ): ValidationResult {
    const approval = this.findApproval(serverId);
    if (!approval || approval.status !== "approved") {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServerToolRegistration", { serverId }), layer: 3 };
    }

    // Protocol/control methods exercise no gated capability.
    if (CONTROL_METHODS.has(method)) {
      return { valid: true };
    }

    // MCP Apps `ui://` reads are the `io.modelcontextprotocol/ui` EXTENSION
    // (gated by the Apps mechanism — `_meta.ui` + CSP), not the core `resources`
    // capability. A tools-only server may legitimately return `_meta.ui` on a
    // tool result and have the host fetch the `ui://` resource, so this read must
    // NOT require `resources` (would break MCP Apps for every tools-only server).
    if (method === "resources/read") {
      const uri = params?.uri;
      if (typeof uri === "string" && uri.startsWith(MCP_APPS_UI_SCHEME)) {
        return { valid: true };
      }
    }

    const required = REQUEST_METHOD_CAPABILITY[method];
    if (required === undefined) {
      // Unknown, non-control method — deny (fail-closed). A new capability verb
      // is denied until explicitly classified, never silently ungated.
      return {
        valid: false,
        reason: `MCP server '${serverId}' sent an unclassified method '${method}' (denied; not a control method and exercises no approved capability)`,
        layer: 3,
      };
    }
    if (!approval.allowedCapabilities.includes(required)) {
      return {
        valid: false,
        reason: `MCP server '${serverId}' is not approved for the '${required}' capability (request '${method}')`,
        layer: 3,
      };
    }
    return { valid: true };
  }


  applyToolNamespace(serverId: string, toolName: string): string {
    const approval = this.findApproval(serverId);
    if (!approval) return toolName;
    const prefix = `mcp_${approval.toolNamePrefix}_`;
    return toolName.startsWith(prefix) ? toolName : `${prefix}${toolName}`;
  }

  // ─── Queries ────────────────────────────────────────

  /** Return approval information for a server. */
  getApproval(serverId: string): McpServerApproval | undefined {
    return this.findApproval(serverId);
  }

  /** Register a host-owned, non-persistent approval for one active plugin generation. */
  registerRuntimeApproval(approval: McpServerApproval): void {
    if (this.policy.servers.some((entry) => entry.id === approval.id)) {
      throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
    }
    const existing = this.runtimeApprovals.get(approval.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
      throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
    }
    this.runtimeApprovals.set(approval.id, Object.freeze({ ...approval }));
  }

  unregisterRuntimeApproval(serverId: string): void {
    this.runtimeApprovals.delete(serverId);
  }

  /** Isolated governance view for hidden candidate discovery. */
  scopedRuntimeApproval(approval: McpServerApproval): McpGovernance {
    if (this.policy.servers.some((entry) => entry.id === approval.id)) {
      throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
    }
    const approvals = new Map(this.runtimeApprovals);
    approvals.set(approval.id, Object.freeze({ ...approval }));
    return new McpGovernance(this.policyPath, { policy: this.policy, runtimeApprovals: approvals });
  }

  /** Atomically replace generation-owned approvals after preparation. */
  replaceRuntimeApprovals(
    predecessorServerIds: Iterable<string>,
    approvals: readonly McpServerApproval[],
  ): void {
    const next = new Map(this.runtimeApprovals);
    for (const serverId of predecessorServerIds) next.delete(serverId);
    for (const approval of approvals) {
      if (this.policy.servers.some((entry) => entry.id === approval.id)) {
        throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
      }
      const existing = next.get(approval.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
        throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
      }
      next.set(approval.id, Object.freeze({ ...approval }));
    }
    this.runtimeApprovals = next;
  }

  /** Validate and prebuild a runtime approval snapshot for atomic publication. */
  prepareRuntimeApprovals(
    predecessorServerIds: Iterable<string>,
    approvals: readonly McpServerApproval[],
  ): { publish(): void } {
    const predecessors = Object.freeze([...predecessorServerIds]);
    const prepared = approvals.map((approval) => Object.freeze({ ...approval }));
    const next = new Map(this.runtimeApprovals);
    for (const serverId of predecessors) next.delete(serverId);
    for (const approval of prepared) {
      if (this.policy.servers.some((entry) => entry.id === approval.id)) {
        throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
      }
      const existing = next.get(approval.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
        throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
      }
      next.set(approval.id, approval);
    }
    let published = false;
    return Object.freeze({
      publish: () => {
        if (published) return;
        for (const serverId of predecessors) this.runtimeApprovals.delete(serverId);
        for (const approval of prepared) this.runtimeApprovals.set(approval.id, approval);
        published = true;
      },
    });
  }

  // ─── Private Validation ──────────────────────────

  private findApproval(serverId: string): McpServerApproval | undefined {
    return this.policy.servers.find((s) => s.id === serverId) ?? this.runtimeApprovals.get(serverId);
  }

  private validateStdioCommand(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.command) {
      return { valid: false, reason: t("be_mcpGovernance.stdioCommandRequired"), layer: 1 };
    }
    const allowed = approval.allowedCommands ?? [];
    // Empty allowedCommands → deny (deny-by-default)
    if (allowed.length === 0 || !allowed.includes(config.command)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.disallowedCommand", { command: config.command, allowedList: allowed.join(", ") }),
        layer: 1,
      };
    }

    // Argument validation blocks known dangerous patterns.
    const dangerousArgs = ["--no-sandbox", "--disable-security", "eval(", "$(", "`"];
    for (const arg of config.args ?? []) {
      if (dangerousArgs.some((d) => arg.includes(d))) {
        return { valid: false, reason: t("be_mcpGovernance.dangerousArgDetected", { arg }), layer: 1 };
      }
    }

    return { valid: true };
  }

  private validateUrl(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.url) {
      return { valid: false, reason: t("be_mcpGovernance.transportRequiresUrl", { transport: config.transport }), layer: 1 };
    }


    for (const pattern of this.policy.globalRules.blockedUrlPatterns) {
      if (matchUrlPattern(pattern, config.url)) {
        return { valid: false, reason: t("be_mcpGovernance.blockedUrlPattern", { url: config.url, pattern }), layer: 1 };
      }
    }


    const allowed = approval.allowedUrls ?? [];
    if (allowed.length > 0) {
      const matches = allowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.disallowedUrl", { url: config.url, allowedList: allowed.join(", ") }),
          layer: 1,
        };
      }
    }


    const globalAllowed = this.policy.globalRules.allowedUrlPatterns;
    if (globalAllowed.length > 0) {
      const matches = globalAllowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.urlNotInGlobalAllowList", { url: config.url }),
          layer: 1,
        };
      }
    }

    return { valid: true };
  }




  private validateHttpScheme(rawUrl: string): ValidationResult {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { valid: false, reason: t("be_mcpGovernance.invalidUrlFormat", { rawUrl }), layer: 1 };
    }
    if (parsed.protocol === "https:") return { valid: true };
    if (parsed.protocol === "http:") {
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        return { valid: true };
      }
      return {
        valid: false,
        reason: t("be_mcpGovernance.httpsRequired", { rawUrl }),
        layer: 1,
      };
    }
    return {
      valid: false,
      reason: t("be_mcpGovernance.httpSchemeOnly", { rawUrl }),
      layer: 1,
    };
  }

  /**
   * Reject header names/values containing CR (\r) or LF (\n). Prevents
   * header-injection / request-splitting attacks even though admin governance
   * is the primary trust boundary. Also rejects control characters that have
   * no business in HTTP headers.
   */
  private validateHeaders(headers: Record<string, string> | undefined): ValidationResult {
    if (!headers) return { valid: true };
    for (const [name, value] of Object.entries(headers)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.headerCrlfForbidden", { name }),
          layer: 1,
        };
      }
      // Defense-in-depth: reject any other control character (U+0000..U+001F
      // except horizontal tab U+0009) in header values.
      if (
        Array.from(value).some((ch) => {
          const cp = ch.charCodeAt(0);
          // Reject U+0000..U+001F except horizontal tab (U+0009) and line
          // feed (U+000A); CR/LF pairs are already rejected above.
          return cp <= 0x1f && cp !== 0x09 && cp !== 0x0a;
        })
      ) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.headerControlCharForbidden", { name }),
          layer: 1,
        };
      }
    }
    return { valid: true };
  }

  private validateApiKeyEnv(
    config: McpServerConfig,
    approval: McpServerApproval,
  ): ValidationResult {
    const name = config.apiKeyEnv;
    const isApiKeyServer = config.auth === "api-key" || approval.requiredAuth === "api-key";
    if (!name) {
      if (!isApiKeyServer) return { valid: true };
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvRequired", { serverId: config.id }),
        layer: 1,
      };
    }
    if (!ENV_NAME_RE.test(name)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvInvalidName", { name }),
        layer: 1,
      };
    }
    if (name.length > MAX_NAME_LEN) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvNameTooLong", { maxLen: MAX_NAME_LEN, name }),
        layer: 1,
      };
    }
    if (RESERVED_ENV_NAMES.has(name.toUpperCase())) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvReserved", { name }),
        layer: 1,
      };
    }
    if (approval.apiKeyEnv !== name) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.unapprovedApiKeyEnv", { name, approvedValue: approval.apiKeyEnv ?? "(none)" }),
        layer: 1,
      };
    }
    return { valid: true };
  }

  private validateApiKeyHeader(
    config: McpServerConfig,
    approval: McpServerApproval,
  ): ValidationResult {
    const name = config.apiKeyHeader;
    if (!name) {
      if (!approval.apiKeyHeader) return { valid: true };
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderRequired", { approvedHeader: approval.apiKeyHeader }),
        layer: 1,
      };
    }
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderInvalidName", { name }),
        layer: 1,
      };
    }
    if (name.length > MAX_NAME_LEN) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderNameTooLong", { maxLen: MAX_NAME_LEN, name }),
        layer: 1,
      };
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderReserved", { name }),
        layer: 1,
      };
    }
    if (approval.apiKeyHeader !== name) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.unapprovedApiKeyHeader", { name, approvedValue: approval.apiKeyHeader ?? "(none)" }),
        layer: 1,
      };
    }
    return { valid: true };
  }

  /**
   * Enforce admin-policy gating for per-server `allowPrivateNetworks`. Either
   * the global rule or the per-server approval must explicitly opt in — a
   * self-elevating per-server config alone is insufficient.
   */
  private validateAllowPrivateNetworks(approval: McpServerApproval): ValidationResult {
    const globalOk = this.policy.globalRules.allowPrivateNetworks === true;
    const serverOk = approval.allowPrivateNetworks === true;
    if (globalOk || serverOk) return { valid: true };
    return {
      valid: false,
      reason: t("be_mcpGovernance.allowPrivateNetworksDenied", { serverId: approval.id }),
      layer: 1,
    };
  }

  private validateConnectionSecurity(config: McpServerConfig, approval: McpServerApproval): ValidationResult {


    if (
      typeof approval.connectionTimeoutMs === "number"
      && approval.connectionTimeoutMs > TOOL_TIMEOUT_POLICY.mcpRequestMaxMs
    ) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.connectionTimeoutPolicyViolation", {
          serverId: approval.id,
          timeoutMs: approval.connectionTimeoutMs,
          maxMs: TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
        }),
        layer: 2,
      };
    }


    if (approval.tlsRequired && config.url) {
      const isSecure = config.url.startsWith("https://") || config.url.startsWith("wss://");
      if (!isSecure) {
        return { valid: false, reason: t("be_mcpGovernance.tlsRequired", { url: config.url }), layer: 2 };
      }
    }


    if (approval.requiredAuth !== "none") {
      if (approval.requiredAuth === "api-key" && !config.apiKey) {
        return { valid: false, reason: t("be_mcpGovernance.apiKeyRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "sso" && config.auth !== "sso") {
        return { valid: false, reason: t("be_mcpGovernance.ssoRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "oauth" && config.auth !== "oauth") {
        return { valid: false, reason: t("be_mcpGovernance.oauthRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "mtls") {
        // mTLS (client-certificate) auth is part of the requiredAuth union but
        // has no client-cert validation implemented anywhere. Fail CLOSED: a
        // server demanding mtls must never satisfy connection-security
        // validation. Previously this case fell through to `valid: true`
        // (fail-OPEN) because only api-key/sso/oauth were handled.
        return { valid: false, reason: t("be_mcpGovernance.mtlsUnsupported", { serverId: config.id }), layer: 2 };
      }
    }

    return { valid: true };
  }
}

function matchUrlPattern(pattern: string, url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const regexStr = "^" + pattern.split("*").map(escapeRegexLiteral).join(".*") + "$";
    return new RegExp(regexStr, "i").test(hostname);
  } catch {
    return url.includes(pattern.replace(/\*/g, ""));
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
