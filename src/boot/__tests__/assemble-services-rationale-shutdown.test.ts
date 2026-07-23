import { describe, expect, it, vi } from "vitest";
import type { BootContext } from "../context.js";
import { assembleAppServices } from "../assemble-services.js";

vi.mock("../plugins.js", () => ({
  registerPluginNotifications: vi.fn(),
}));

vi.mock("../../main/auth-window-service.js", () => ({
  clearAuthPartition: vi.fn(),
  forgetTrackedPluginAuthPartitions: vi.fn(),
  getTrackedPluginAuthPartitions: vi.fn(),
}));

describe("assembleAppServices rationale shutdown", () => {
  it("aborts interactive loops and drains teardown after a rationale shutdown failure", async () => {
    const order: string[] = [];
    const mark = (name: string) => () => {
      order.push(name);
    };
    const ctx = {
      disposePluginNotifications: mark("plugin-notifications"),
      disposePluginEventBridge: mark("plugin-event-bridge"),
      preferenceRefreshService: { stop: mark("preference") },
      idleScheduler: { stop: mark("idle") },
      routinesScheduler: { stop: mark("routines") },
      dueSoonTimer: undefined,
      conversationLoop: { abortCurrentTurn: mark("main-abort") },
      sideChatConversationLoop: { abortCurrentTurn: mark("side-abort") },
      rationaleHostService: {
        shutdown: () => {
          order.push("rationale");
          throw new Error("rationale shutdown failed");
        },
      },
      approvalGate: { disposeAll: mark("approval") },
      askUserQuestionGate: { disposeAll: mark("ask") },
      mcpGovernance: { stopPolicyRefresh: mark("mcp-policy") },
      mcpManager: {
        disconnectAll: vi.fn(async () => {
          order.push("mcp");
        }),
      },
      bootAuditLogger: {
        close: vi.fn(async () => {
          order.push("audit-writer");
        }),
      },
      auditService: {
        stop: vi.fn(async () => {
          order.push("audit");
        }),
      },
      lateBinding: { pluginToolInvokerRef: { fn: undefined } },
    } as unknown as BootContext;

    const services = assembleAppServices(ctx);
    const shutdown = services.shutdown();

    await expect(shutdown).rejects.toThrow("application service shutdown failed");
    expect(order).toEqual([
      "plugin-notifications",
      "plugin-event-bridge",
      "preference",
      "idle",
      "routines",
      "main-abort",
      "side-abort",
      "rationale",
      "approval",
      "ask",
      "mcp-policy",
      "mcp",
      "audit-writer",
      "audit",
    ]);
    expect(services.shutdown()).toBe(shutdown);
  });
});
