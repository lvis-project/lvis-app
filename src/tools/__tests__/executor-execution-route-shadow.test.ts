import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { ToolExecutor } from "../executor.js";
import type { ToolCallMeta } from "../executor-contract.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";

afterEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
});

describe("execution route shadow metadata", () => {
  it("keeps the existing dynamic-path denial while refusing automatic host selection", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-shadow-"));
    try {
      const registry = new ToolRegistry();
      registry.register(new BashTool());
      const permissions = new PermissionManager(join(dir, "permissions.json"));
      permissions.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 5 });
      const appendPermissionAuditEntry = vi.fn();
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: () => true,
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permissions,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );
      const onToolEnd = vi.fn<(
        name: string,
        result: string,
        isError: boolean,
        meta: ToolCallMeta,
      ) => void>();

      const [result] = await executor.executeAll(
        [{ id: "tu-route-shadow", name: "bash", input: {
          command: "cat $UNRESOLVED_FILE",
          // Both are valid under the existing shell contract. The shadow
          // layer must use resolved cwd and preserve the seconds value rather
          // than introducing a narrower millisecond safe-integer check.
          cwd: "",
          timeoutSeconds: Number.MAX_SAFE_INTEGER,
        } }],
        {
          sessionId: "sess-route-shadow",
          permissionContext: { trustOrigin: "llm-tool-arg" },
          callbacks: { onToolEnd },
        },
      );

      expect(result).toMatchObject({
        is_error: true,
        executionPlan: { mode: "plain" },
      });
      expect(result.content).toContain("shell-path-policy/dynamic-path");
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        toolUseId: "tu-route-shadow",
        executionRoute: expect.objectContaining({
          decision: "analysis-required",
          route: null,
          fallback: "analysis-uncertain",
          cwd: process.cwd(),
          runtimeLimits: {
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
            background: false,
          },
          unresolvedRequirements: [{
            classification: "analysis-uncertain",
            source: "shell-path-policy",
            kind: "dynamic-path",
          }],
        }),
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
