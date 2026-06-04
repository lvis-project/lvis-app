import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGovernance } from "../mcp-governance.js";
import type { McpGovernancePolicy, McpServerApproval } from "../types.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const testDir = join(tmpdir(), `lvis-mcp-governance-${process.pid}`);
const policyPath = join(testDir, "mcp-policy.json");

async function writePolicy(policy: McpGovernancePolicy): Promise<void> {
  if (!existsSync(testDir)) {
    await mkdir(testDir, { recursive: true });
  }
  await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf-8");
}

function makePolicy(status: "approved" | "revoked"): McpGovernancePolicy {
  return {
    version: "1.0",
    defaultPolicy: "deny",
    servers: [
      {
        id: "srv-a",
        status,
        allowedTransports: ["stdio"],
        allowedOrigins: [],
        maxTools: 5,
        maxConcurrentRequests: 2,
        toolPermissionMode: "default",
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "full",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 20,
    },
  };
}

function governanceWithPolicy(policy: McpGovernancePolicy): McpGovernance {
  const governance = new McpGovernance("/nonexistent/mcp-policy.json");
  (governance as unknown as { policy: McpGovernancePolicy }).policy = policy;
  return governance;
}

function basePolicy(server: Partial<McpServerApproval>): McpGovernancePolicy {
  return {
    version: "1.0-test",
    defaultPolicy: "deny",
    servers: [
      {
        id: "browser-use",
        name: "Browser Use",
        status: "approved",
        transport: "stdio",
        allowedCommands: ["uvx"],
        requiredAuth: "api-key",
        apiKeyEnv: "OPENAI_API_KEY",
        tlsRequired: false,
        allowedCapabilities: ["tools"],
        maxTools: 16,
        toolNamePrefix: "browser_use",
        toolPermissionMode: "default",
        maxResponseSizeBytes: 1_000_000,
        connectionTimeoutMs: 5_000,
        maxConcurrentRequests: 4,
        ...server,
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "full",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 20,
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await rm(testDir, { recursive: true, force: true });
});

// ─── Round 2 security tests: denylist + cap (PR #765) ────────────

function makeStdioPolicy(apiKeyEnv?: string): McpGovernancePolicy {
  return {
    version: "1.0",
    defaultPolicy: "deny",
    servers: [
      {
        id: "test-stdio",
        name: "test-stdio",
        status: "approved",
        transport: "stdio",
        allowedCommands: ["uvx"],
        requiredAuth: "api-key",
        apiKeyEnv: apiKeyEnv ?? "MY_API_KEY",
        tlsRequired: false,
        allowedCapabilities: ["tools"],
        maxTools: 16,
        toolNamePrefix: "test",
        toolPermissionMode: "default",
        maxResponseSizeBytes: 1_000_000,
        connectionTimeoutMs: 5_000,
        maxConcurrentRequests: 4,
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "full",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 60_000,
    },
  };
}

function makeHttpPolicy(): McpGovernancePolicy {
  return {
    version: "1.0",
    defaultPolicy: "deny",
    servers: [
      {
        id: "test-http",
        name: "test-http",
        status: "approved",
        transport: "http",
        allowedUrls: ["example.com"],
        requiredAuth: "api-key",
        apiKeyHeader: "x-api-key",
        tlsRequired: true,
        allowedCapabilities: ["tools"],
        maxTools: 16,
        toolNamePrefix: "test",
        toolPermissionMode: "default",
        maxResponseSizeBytes: 1_000_000,
        connectionTimeoutMs: 5_000,
        maxConcurrentRequests: 4,
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "full",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 60_000,
    },
  };
}

describe("McpGovernance — apiKeyEnv denylist (CRITICAL-1)", () => {
  it("rejects LD_PRELOAD", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "LD_PRELOAD",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 환경변수/);
  });

  it("rejects PATH (case-insensitive)", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "path",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 환경변수/);
  });

  it("rejects NODE_OPTIONS", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "NODE_OPTIONS",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 환경변수/);
  });

  it("rejects DYLD_INSERT_LIBRARIES", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "DYLD_INSERT_LIBRARIES",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 환경변수/);
  });

  it("rejects env name longer than 64 chars", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "A".repeat(65),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/너무 깁니다/);
  });

  it("accepts a safe custom env name (MY_API_KEY)", async () => {
    await writePolicy(makeStdioPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "MY_API_KEY",
    });
    expect(result.valid).toBe(true);
  });
});

describe("McpGovernance — apiKeyHeader denylist (HIGH-1)", () => {
  it("rejects Authorization header (case-insensitive)", async () => {
    await writePolicy(makeHttpPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-http",
      transport: "http",
      url: "https://example.com/mcp",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyHeader: "Authorization",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 HTTP 헤더/);
  });

  it("rejects Cookie header", async () => {
    await writePolicy(makeHttpPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-http",
      transport: "http",
      url: "https://example.com/mcp",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyHeader: "Cookie",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/예약된 HTTP 헤더/);
  });

  it("rejects header name longer than 64 chars", async () => {
    await writePolicy(makeHttpPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-http",
      transport: "http",
      url: "https://example.com/mcp",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyHeader: "x-" + "a".repeat(63),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/너무 깁니다/);
  });

  it("accepts a safe custom header (x-api-key)", async () => {
    await writePolicy(makeHttpPolicy());
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-http",
      transport: "http",
      url: "https://example.com/mcp",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyHeader: "x-api-key",
    });
    expect(result.valid).toBe(true);
  });
});

describe("McpGovernance.startPolicyRefresh", () => {
  it("notifies newly revoked servers once per transition", async () => {
    vi.useFakeTimers();
    await writePolicy(makePolicy("approved"));
    const governance = new McpGovernance(policyPath);
    const onRevoked = vi.fn();

    governance.startPolicyRefresh(onRevoked);

    await writePolicy(makePolicy("revoked"));
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);

    expect(onRevoked).toHaveBeenCalledOnce();
    expect(onRevoked).toHaveBeenCalledWith(["srv-a"]);

    governance.stopPolicyRefresh();
  });
});

describe("McpGovernance.validateServer — API key sinks", () => {
  it("accepts a stdio API key env only when it exactly matches approval", () => {
    const governance = governanceWithPolicy(basePolicy({}));

    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        auth: "api-key",
        apiKey: "sk-test",
        apiKeyEnv: "OPENAI_API_KEY",
      }),
    ).toEqual({ valid: true });
  });

  it("rejects unapproved or reserved stdio API key env names", () => {
    const governance = governanceWithPolicy(basePolicy({}));

    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        auth: "api-key",
        apiKey: "sk-test",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      }).valid,
    ).toBe(false);
    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        auth: "api-key",
        apiKey: "sk-test",
        apiKeyEnv: "PATH",
      }).valid,
    ).toBe(false);
  });

  it("accepts a custom HTTP API key header only when it exactly matches approval", () => {
    const governance = governanceWithPolicy(
      basePolicy({
        transport: "http",
        allowedCommands: undefined,
        allowedUrls: ["api.browser-use.com"],
        apiKeyEnv: undefined,
        apiKeyHeader: "x-browser-use-api-key",
      }),
    );

    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "http",
        url: "https://api.browser-use.com/v3/mcp",
        auth: "api-key",
        apiKey: "browser-use-secret",
        apiKeyHeader: "x-browser-use-api-key",
      }),
    ).toEqual({ valid: true });
  });

  it("rejects unapproved or control HTTP API key header names", () => {
    const governance = governanceWithPolicy(
      basePolicy({
        transport: "http",
        allowedCommands: undefined,
        allowedUrls: ["api.browser-use.com"],
        apiKeyEnv: undefined,
        apiKeyHeader: "x-browser-use-api-key",
      }),
    );

    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "http",
        url: "https://api.browser-use.com/v3/mcp",
        auth: "api-key",
        apiKey: "browser-use-secret",
        apiKeyHeader: "x-other-api-key",
      }).valid,
    ).toBe(false);
    expect(
      governance.validateServer({
        id: "browser-use",
        transport: "http",
        url: "https://api.browser-use.com/v3/mcp",
        auth: "api-key",
        apiKey: "browser-use-secret",
        apiKeyHeader: "content-type",
      }).valid,
    ).toBe(false);
  });
});

describe("McpGovernance — connectionTimeoutMs policy cap (ingestion clamp)", () => {
  it("rejects an approval whose connectionTimeoutMs exceeds mcpRequestMaxMs", async () => {
    const aboveCap = TOOL_TIMEOUT_POLICY.mcpRequestMaxMs + 1;
    const policy: McpGovernancePolicy = {
      version: "1.0",
      defaultPolicy: "deny",
      servers: [
        {
          id: "test-stdio",
          name: "test-stdio",
          status: "approved",
          transport: "stdio",
          allowedCommands: ["uvx"],
          requiredAuth: "api-key",
          apiKeyEnv: "MY_API_KEY",
          tlsRequired: false,
          allowedCapabilities: ["tools"],
          maxTools: 16,
          toolNamePrefix: "test",
          toolPermissionMode: "default",
          maxResponseSizeBytes: 1_000_000,
          connectionTimeoutMs: aboveCap,
          maxConcurrentRequests: 4,
        },
      ],
      globalRules: {
        maxServersTotal: 10,
        blockedUrlPatterns: [],
        allowedUrlPatterns: [],
        auditLevel: "full",
        killSwitchEnabled: true,
        policyRefreshIntervalMs: 60_000,
      },
    };
    await writePolicy(policy);
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "MY_API_KEY",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/connectionTimeoutMs 정책 상한 위반/);
  });

  it("accepts an approval whose connectionTimeoutMs is within the cap", async () => {
    const withinCap = TOOL_TIMEOUT_POLICY.mcpRequestMaxMs;
    const policy: McpGovernancePolicy = {
      version: "1.0",
      defaultPolicy: "deny",
      servers: [
        {
          id: "test-stdio",
          name: "test-stdio",
          status: "approved",
          transport: "stdio",
          allowedCommands: ["uvx"],
          requiredAuth: "api-key",
          apiKeyEnv: "MY_API_KEY",
          tlsRequired: false,
          allowedCapabilities: ["tools"],
          maxTools: 16,
          toolNamePrefix: "test",
          toolPermissionMode: "default",
          maxResponseSizeBytes: 1_000_000,
          connectionTimeoutMs: withinCap,
          maxConcurrentRequests: 4,
        },
      ],
      globalRules: {
        maxServersTotal: 10,
        blockedUrlPatterns: [],
        allowedUrlPatterns: [],
        auditLevel: "full",
        killSwitchEnabled: true,
        policyRefreshIntervalMs: 60_000,
      },
    };
    await writePolicy(policy);
    const gov = new McpGovernance(policyPath);
    const result = gov.validateServer({
      id: "test-stdio",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "MY_API_KEY",
    });
    expect(result.valid).toBe(true);
  });
});

describe("McpGovernance.validateServer — requiredAuth fail-closed", () => {
  it("rejects a server requiring unsupported mtls auth (previously fell through to valid:true)", () => {
    const governance = governanceWithPolicy(basePolicy({ requiredAuth: "mtls" }));
    const result = governance.validateServer({
      id: "browser-use",
      transport: "stdio",
      command: "uvx",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mTLS/);
  });
});
