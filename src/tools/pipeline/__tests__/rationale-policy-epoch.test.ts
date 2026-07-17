import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookRunner } from "../../../hooks/hook-runner.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import {
  clearCategoryRegistry,
  getCategoryRegistryGeneration,
  registerStandardCategories,
} from "../../../permissions/category-registry.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import {
  __resetSessionStoreForTest,
  getUserApprovalGeneration,
  recordApproval,
} from "../../../permissions/user-approval-store.js";
import { captureRationalePolicyEpoch } from "../rationale-policy-epoch.js";

function epoch(input: {
  permissionManager?: PermissionManager;
  hookRunner?: HookRunner;
  scriptHookManager?: ScriptHookManager;
  additionalDirectories?: readonly string[];
} = {}): string {
  return captureRationalePolicyEpoch({
    permissionManager: input.permissionManager,
    hookRunner: input.hookRunner ?? new HookRunner(),
    scriptHookManager: input.scriptHookManager,
    additionalDirectories: input.additionalDirectories ?? [],
  });
}

afterEach(() => {
  __resetSessionStoreForTest();
  registerStandardCategories();
});

describe("rationale policy epoch", () => {
  it("tracks PermissionManager mode, threshold, reviewer, rule, and override mutations but not stable setters", () => {
    const permissionManager = new PermissionManager("unused-permissions.json");
    const common = {
      permissionManager,
      hookRunner: new HookRunner(),
      scriptHookManager: new ScriptHookManager(),
    };
    let previous = epoch(common);
    const changes = (mutate: () => void) => {
      mutate();
      const next = epoch(common);
      expect(next).not.toBe(previous);
      previous = next;
    };

    changes(() => permissionManager.setMode("auto"));
    changes(() => permissionManager.setInteractiveAutoApprove("low"));
    changes(() => permissionManager.setReviewer({
      classifier: { classify: vi.fn() } as never,
      cache: {} as never,
      deferredQueue: {} as never,
    }));
    changes(() => permissionManager.setRules([
      { pattern: "bash", action: "deny" },
    ]));
    changes(() => permissionManager.setToolModeOverride("bash", "strict"));

    const stable = epoch(common);
    permissionManager.setMode("auto");
    permissionManager.setInteractiveAutoApprove("low");
    permissionManager.setToolModeOverride("bash", "strict");
    expect(epoch(common)).toBe(stable);
  });

  it("tracks HookRunner and ScriptHookManager mutations", () => {
    const hookRunner = new HookRunner();
    const scriptHookManager = new ScriptHookManager();
    const common = { hookRunner, scriptHookManager };
    const initial = epoch(common);
    hookRunner.registerPreHook("rationale-pre", () => ({ action: "allow" }));
    const withPreHook = epoch(common);
    expect(withPreHook).not.toBe(initial);
    scriptHookManager.setTrustedRegistry([], []);
    expect(epoch(common)).not.toBe(withPreHook);
  });

  it("tracks Store B mutation and leaves an empty reset stable", async () => {
    __resetSessionStoreForTest();
    const empty = getUserApprovalGeneration();
    __resetSessionStoreForTest();
    expect(getUserApprovalGeneration()).toBe(empty);

    const before = epoch();
    await recordApproval("bash", '{"command":"pwd"}', "builtin", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
    });
    expect(epoch()).not.toBe(before);
  });

  it("tracks category membership and leaves an already-empty clear stable", () => {
    const before = epoch();
    clearCategoryRegistry();
    const after = epoch();
    expect(after).not.toBe(before);

    const empty = getCategoryRegistryGeneration();
    clearCategoryRegistry();
    expect(getCategoryRegistryGeneration()).toBe(empty);
    expect(epoch()).toBe(after);
  });

  it.each([
    ["Windows", "C:\\workspace", "D:\\shared"],
    ["macOS", "/Users/test/workspace", "/Volumes/shared"],
    ["Linux", "/home/test/workspace", "/mnt/shared"],
  ] as const)(
    "tracks additionalDirectories on %s without order or duplicate churn",
    (_platform, workspace, extra) => {
      const baseline = epoch({ additionalDirectories: [workspace] });
      const added = epoch({ additionalDirectories: [workspace, extra] });
      expect(added).not.toBe(baseline);
      expect(epoch({
        additionalDirectories: [extra, workspace, extra],
      })).toBe(added);
    },
  );

  it("keeps anchor and epoch wiring on one host-OS-independent path", () => {
    for (const relativePath of [
      "../../../ipc/handlers/chat.ts",
      "../../../engine/turn/run-turn.ts",
      "../../../engine/turn/trust-origin.ts",
      "../rationale-policy-epoch.ts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/process\.platform/);
      expect(source).not.toMatch(
        /(?:case\s+|===\s*|!==\s*)["'](?:win32|darwin|linux)["']/,
      );
    }
  });
});
