import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";

function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function makeReviewedNetworkProbe(name: string, executeSpy: ReturnType<typeof vi.fn>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name,
    description: "MEDIUM reviewer retry boundary probe",
    source: "plugin",
    pluginId: "test-plugin",
    category: "network",
    jsonSchema: {
      type: "object",
      properties: { payload: { type: "string" } },
    },
    execute: async (rawInput) => ({
      output: await executeSpy(rawInput),
      isError: false,
    }),
  }));
  return registry;
}

function makePermissionManager(dir: string, classifySpy: ReturnType<typeof vi.fn>): PermissionManager {
  const permMgr = new PermissionManager(join(dir, "permissions.json"));
  permMgr.setMode("default");
  permMgr.setInteractiveAutoApprove("low");
  permMgr.setReviewer({
    classifier: { classify: classifySpy },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
  });
  return permMgr;
}

describe("ToolExecutor foreground reviewer explicit retry boundaries", () => {
  it("does not record or consume explicit reviewer authorization without a session id", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const classifySpy = vi.fn(() => ({
      level: "medium" as const,
      reason: "needs user confirmation",
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-retry-nosession-"));
    try {
      const toolName = "reviewed_network_retry_no_session";
      const executor = new ToolExecutor(
        makeReviewedNetworkProbe(toolName, executeSpy),
        undefined,
        makePermissionManager(dir, classifySpy),
      );
      const input = { payload: "send release notice" };

      const first = await executor.executeAll(
        [{ id: "tu-nosession-first", name: toolName, input }],
        {
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const second = await executor.executeAll(
        [{ id: "tu-nosession-second", name: toolName, input }],
        {
          permissionContext: userPermissionContext({
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      expect(second[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifySpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts old explicit reviewer authorizations when pending retries exceed the cap", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const classifySpy = vi.fn(() => ({
      level: "medium" as const,
      reason: "needs user confirmation",
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-retry-cap-"));
    try {
      const toolName = "reviewed_network_retry_cap";
      const executor = new ToolExecutor(
        makeReviewedNetworkProbe(toolName, executeSpy),
        undefined,
        makePermissionManager(dir, classifySpy),
      );
      const inputs = Array.from({ length: 65 }, (_, index) => ({
        payload: `send release notice ${index}`,
      }));

      for (const [index, input] of inputs.entries()) {
        const result = await executor.executeAll(
          [{ id: `tu-cap-first-${index}`, name: toolName, input }],
          {
            sessionId: "sess-reviewer-retry-cap",
            permissionContext: userPermissionContext({
              userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
            }),
          },
        );
        expect(result[0].is_error).toBe(true);
      }

      const oldestRetry = await executor.executeAll(
        [{ id: "tu-cap-oldest-retry", name: toolName, input: inputs[0] }],
        {
          sessionId: "sess-reviewer-retry-cap",
          permissionContext: userPermissionContext({
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      expect(oldestRetry[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();

      const newestRetry = await executor.executeAll(
        [{ id: "tu-cap-newest-retry", name: toolName, input: inputs[64] }],
        {
          sessionId: "sess-reviewer-retry-cap",
          permissionContext: userPermissionContext({
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      expect(newestRetry[0].is_error).toBeUndefined();
      expect(newestRetry[0].content).toBe("sent");
      expect(executeSpy).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reuse explicit reviewer authorization across trust origins", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const classifySpy = vi.fn(() => ({
      level: "medium" as const,
      reason: "needs user confirmation",
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-retry-origin-"));
    try {
      const toolName = "reviewed_network_retry_origin";
      const executor = new ToolExecutor(
        makeReviewedNetworkProbe(toolName, executeSpy),
        undefined,
        makePermissionManager(dir, classifySpy),
      );
      const input = { payload: "send release notice" };

      const first = await executor.executeAll(
        [{ id: "tu-origin-first", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-origin",
          permissionContext: userPermissionContext({
            trustOrigin: "llm-tool-arg",
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const second = await executor.executeAll(
        [{ id: "tu-origin-second", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-origin",
          permissionContext: userPermissionContext({
            trustOrigin: "file-content",
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      expect(second[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifySpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume explicit reviewer authorization during headless retry attempts", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const classifySpy = vi.fn(() => ({
      level: "medium" as const,
      reason: "needs user confirmation",
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-retry-headless-"));
    try {
      const toolName = "reviewed_network_retry_headless";
      const executor = new ToolExecutor(
        makeReviewedNetworkProbe(toolName, executeSpy),
        undefined,
        makePermissionManager(dir, classifySpy),
      );
      const input = { payload: "send release notice" };

      const first = await executor.executeAll(
        [{ id: "tu-headless-first", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-headless",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const second = await executor.executeAll(
        [{ id: "tu-headless-second", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-headless",
          permissionContext: userPermissionContext({
            headless: true,
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      expect(second[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifySpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
