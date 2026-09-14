import { describe, expect, it, vi } from "vitest";
import {
  isClaudeCodeSubscriptionProviderId,
  claudeCodeSubscriptionStatus,
} from "../../shared/claude-code-subscription.js";
import {
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  SUBSCRIPTION_RUNTIME_DESCRIPTORS,
} from "../../shared/subscription-runtime.js";
import {
  resolveClaudeCodeSubscriptionExecutable,
  sanitizedClaudeCodeEnvironment,
} from "../claude-code-subscription-client.js";
import { claudeCodeMcpToolNames } from "../claude-code-conversation-runtime.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { SubscriptionRuntimeService } from "../subscription-runtime-service.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import type { AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import type { ClaudeCodeSubscriptionClient } from "../claude-code-subscription-client.js";

function namespace(): FeatureNamespaceHandle {
  return {
    dir: "C:\\isolated\\subscription-runtimes",
    childDir: vi.fn(async (name: string) => `C:\\isolated\\subscription-runtimes\\${name}`),
    readJson: vi.fn(async (_name: string, fallback: unknown) => fallback),
    writeJson: vi.fn(async () => undefined),
  } as unknown as FeatureNamespaceHandle;
}

function fakeCodexClient(): CodexAppServerClient {
  return {
    getStatus: vi.fn(async () => ({
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    })),
    getCachedStatus: vi.fn(() => ({
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    })),
    listModels: vi.fn(async () => ({ status: {
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    }, models: [] })),
    stop: vi.fn(),
  } as unknown as CodexAppServerClient;
}

describe("claude-code subscription contract", () => {
  it("registers claude-code as a browser-login CLI subscription runtime", () => {
    expect(isSubscriptionRuntimeId("claude-code")).toBe(true);
    expect(isClaudeCodeSubscriptionProviderId("claude-code")).toBe(true);
    expect(isClaudeCodeSubscriptionProviderId("codex")).toBe(false);
    const descriptor = subscriptionRuntimeDescriptor("claude-code");
    expect(descriptor.transport).toBe("claude-cli");
    expect(descriptor.requiresExecutable).toBe(true);
    expect(descriptor.loginMethods).toEqual(["browser"]);
    expect(descriptor.supportsManagedLogout).toBe(true);
    expect(descriptor.supportsModelSelection).toBe(false);
    expect(SUBSCRIPTION_RUNTIME_DESCRIPTORS.some((entry) => entry.id === "claude-code")).toBe(true);
  });

  it("builds host MCP tool names from bridge schemas", () => {
    expect(claudeCodeMcpToolNames([
      {
        name: "read_project_file",
        description: "Read one project file",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ])).toEqual(["mcp__lvis-host-tools__read_project_file"]);
  });

  it("isolates CLAUDE_CONFIG_DIR and strips foreign auth environment", () => {
    const env = sanitizedClaudeCodeEnvironment(
      "C:\\isolated\\claude-home",
      {
        PATH: "C:\\Windows\\System32",
        ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
        CLAUDE_CONFIG_DIR: "C:\\Users\\example\\.claude",
        LANG: "en_US.UTF-8",
      },
      "win32",
      "C:\\isolated\\claude-tmp",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\isolated\\claude-home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TEMP).toBe("C:\\isolated\\claude-tmp");
  });

  it("rejects relative executable paths", async () => {
    await expect(resolveClaudeCodeSubscriptionExecutable("claude.exe", "win32"))
      .rejects.toMatchObject({ code: "claude-code-runtime-invalid-executable" });
  });

  it("projects connected Claude Code status only after verify", async () => {
    const claudeCodeClient = {
      getStatus: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
      verify: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
      getConfiguredExecutable: vi.fn(() => "C:\\Tools\\claude.exe"),
      getRuntimePaths: vi.fn(() => ({
        runtimeHome: "C:\\isolated\\claude-home",
        workspaceDir: "C:\\isolated\\claude-workspace",
        runtimeTempDir: "C:\\isolated\\claude-tmp",
      })),
      stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const registry = {
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(),
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
      claudeCodeClient,
    });

    expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
    expect((await service.verify("claude-code")).capabilities).toMatchObject({
      chat: true,
      tools: true,
      images: false,
    });
  });
});
