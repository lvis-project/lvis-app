import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createDynamicTool } from "../base.js";
import { ToolExecutor, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { makePermissionManager } from "./executor-reviewer-fixtures.js";

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

function makeAutoPermissionManager(
  dir: string,
  classifySpy: ReturnType<typeof vi.fn>,
) {
  const permMgr = makePermissionManager(dir, classifySpy);
  permMgr.setMode("auto");
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
        makeAutoPermissionManager(dir, classifySpy),
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

  it("no longer auto-allows reviewer-rated retries via text authorization (modal supersedes text re-auth)", async () => {
    // Phase 0: the foreground reviewer lane now ASKS (routes to the approval
    // modal) instead of returning a silent deny. Because the deny-path-only
    // recordPendingReviewerAuthorization is never reached, the text-based
    // "진행해" re-authorization path is dormant: a chat retry no longer grants
    // execution on its own — user authority lives in the approval modal. With
    // no approval gate wired here, the reviewer-rated call fails closed both
    // times, including the explicit-intent retry.
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
        makeAutoPermissionManager(dir, classifySpy),
      );
      const input = { payload: "send release notice" };

      const first = await executor.executeAll(
        [{ id: "tu-cap-first", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-cap",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const retry = await executor.executeAll(
        [{ id: "tu-cap-retry", name: toolName, input }],
        {
          sessionId: "sess-reviewer-retry-cap",
          permissionContext: userPermissionContext({
            userIntent: "진행해",
            explicitAuthorizationIntent: "진행해",
          }),
        },
      );

      // Text re-auth is dormant — the retry is NOT auto-allowed.
      expect(retry[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
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
        makeAutoPermissionManager(dir, classifySpy),
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
        makeAutoPermissionManager(dir, classifySpy),
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
