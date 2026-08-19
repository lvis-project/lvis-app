import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

describe("wireReviewerAndPermissions subscription runtime", () => {
  it("uses the shared active subscription factory and a transport-scoped reviewer identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-subscription-"));
    vi.resetModules();
    const wireReviewerAgent = vi.fn((_input: unknown) => ({ rationaleScopeReviewer: {} }));
    vi.doMock("electron", () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock("../reviewer-wiring.js", () => ({ wireReviewerAgent }));
    vi.doMock("../../../ipc/domains/permissions.js", () => ({
      broadcastPermissionConfigChanged: vi.fn(),
    }));

    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      const selection = {
        kind: "subscription" as const,
        provider: "codex" as const,
        model: "gpt-5.5-codex",
      };
      const subscriptionProvider: LLMProvider = {
        vendor: "openai",
        subscriptionRuntime: selection,
        async *streamTurn() {},
      };
      const subscriptionProviderFactory = vi.fn(() => subscriptionProvider);
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              // Deliberately different: reviewer must not consult this stale
              // API-key setting while the subscription runtime is active.
              provider: "claude",
              activeChatRuntime: selection,
              vendors: { claude: { model: "claude-sonnet-4-5" } },
            };
          }
          return {};
        }),
        getSecret: vi.fn(() => null),
      };
      const permissionManager = new PermissionManager(join(tempDir, "permissions.json"));
      const context = {
        toolRegistry: { setDenyRules: vi.fn() },
        permissionManager,
        settingsService,
        llmFetch: vi.fn(),
        getMainWindow: () => null,
        bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory,
      };

      wireReviewerAndPermissions(context as never);

      const options = wireReviewerAgent.mock.calls[0]?.[0] as unknown as {
        readActiveLlm: () => { provider: string; model: string };
        streamProviderFor: (provider: string) => LLMProvider | null;
      };
      expect(options.readActiveLlm()).toEqual({
        provider: "subscription:codex",
        model: "gpt-5.5-codex",
      });
      expect(options.streamProviderFor("subscription:codex")).toBe(subscriptionProvider);
      expect(subscriptionProviderFactory).toHaveBeenCalledWith(selection);
      // A forged/legacy API-key identity cannot fall through while a
      // subscription runtime owns the active reviewer transport.
      expect(options.streamProviderFor("claude")).toBeNull();
      expect(subscriptionProviderFactory).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("electron");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../../../ipc/domains/permissions.js");
      vi.resetModules();
      await cleanupTmpDir(tempDir);
    }
  });
});
