import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../plugins/types.js";
import { PluginOperationGrantCoordinator } from "../../../permissions/plugin-operation-grant.js";
import { resolvePluginOperationAccount } from "../plugin-operation-account.js";

function resolver(
  identity:
    | { identityHash: string; principalHash: string }
    | undefined,
) {
  return {
    getPluginOperationAccountIdentity: vi.fn(() => identity),
  };
}

describe("resolvePluginOperationAccount", () => {
  it("keeps authenticated authority separate from the stable account scope", () => {
    const runtime = resolver({
      identityHash: "authenticated-scope",
      principalHash: "authenticated-principal",
    });

    expect(
      resolvePluginOperationAccount(
        runtime,
        { auth: {} } as PluginManifest,
        "ep-api",
        "generation-a",
      ),
    ).toEqual({
      accountHash: "authenticated-principal",
      accountScopeHash: "authenticated-scope",
    });
  });

  it("requires a fresh account binding when the manifest declares auth", () => {
    const runtime = resolver(undefined);

    expect(
      resolvePluginOperationAccount(
        runtime,
        { auth: {} } as PluginManifest,
        "ep-api",
        "generation-a",
      ),
    ).toBeUndefined();
  });

  it("rotates an authless principal by generation while retaining its stable plugin scope", () => {
    const runtime = resolver(undefined);
    const manifest = {} as PluginManifest;
    const first = resolvePluginOperationAccount(
      runtime,
      manifest,
      "ep-api",
      "generation-a",
    );
    const same = resolvePluginOperationAccount(
      runtime,
      manifest,
      "ep-api",
      "generation-a",
    );
    const replacement = resolvePluginOperationAccount(
      runtime,
      manifest,
      "ep-api",
      "generation-b",
    );
    const otherPlugin = resolvePluginOperationAccount(
      runtime,
      manifest,
      "other-plugin",
      "generation-a",
    );

    expect(first?.accountHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.accountScopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toEqual(first);
    expect(replacement?.accountHash).not.toBe(first?.accountHash);
    expect(replacement?.accountScopeHash).toBe(first?.accountScopeHash);
    expect(otherPlugin?.accountScopeHash).not.toBe(first?.accountScopeHash);
  });

  it("preserves fail-closed poison through real anonymous replacement and authenticated reauthentication resolution", async () => {
    const anonymousRuntime = resolver(undefined);
    const anonymousManifest = {} as PluginManifest;
    const predecessor = resolvePluginOperationAccount(
      anonymousRuntime,
      anonymousManifest,
      "ep-api",
      "generation-a",
    )!;
    const replacement = resolvePluginOperationAccount(
      anonymousRuntime,
      anonymousManifest,
      "ep-api",
      "generation-b",
    )!;
    const anonymousCoordinator = new PluginOperationGrantCoordinator();
    const predecessorDomain = "a".repeat(64);
    anonymousCoordinator.recordRead({
      ownerPluginId: "ep-api",
      ownerVersion: "1.0.0",
      generationId: "generation-a",
      appSessionId: "window-a",
      ...predecessor,
      readTool: "attendance_read",
      readOperation: "today",
    }, predecessorDomain);
    anonymousCoordinator.poisonDomain(predecessorDomain);

    await expect(anonymousCoordinator.acquireExecutionLease(
      "b".repeat(64),
      {
        ownerPluginId: "ep-api",
        ownerVersion: "2.0.0",
        generationId: "generation-b",
        appSessionId: "window-b",
        ...replacement,
      },
    )).rejects.toThrow("indeterminate");

    let authenticatedIdentity = {
      identityHash: "stable-authenticated-identity",
      principalHash: "login-session-a",
    };
    const authenticatedRuntime = {
      getPluginOperationAccountIdentity: vi.fn(() => authenticatedIdentity),
    };
    const authenticatedManifest = { auth: {} } as PluginManifest;
    const firstLogin = resolvePluginOperationAccount(
      authenticatedRuntime,
      authenticatedManifest,
      "ep-api",
      "generation-a",
    )!;
    const authenticatedCoordinator = new PluginOperationGrantCoordinator();
    const firstLoginDomain = "c".repeat(64);
    authenticatedCoordinator.recordRead({
      ownerPluginId: "ep-api",
      ownerVersion: "1.0.0",
      generationId: "generation-a",
      appSessionId: "window-c",
      ...firstLogin,
      readTool: "attendance_read",
      readOperation: "today",
    }, firstLoginDomain);
    authenticatedCoordinator.poisonDomain(firstLoginDomain);
    authenticatedIdentity = {
      ...authenticatedIdentity,
      principalHash: "login-session-b",
    };
    const secondLogin = resolvePluginOperationAccount(
      authenticatedRuntime,
      authenticatedManifest,
      "ep-api",
      "generation-a",
    )!;

    expect(secondLogin.accountHash).not.toBe(firstLogin.accountHash);
    expect(secondLogin.accountScopeHash).toBe(firstLogin.accountScopeHash);
    await expect(authenticatedCoordinator.acquireExecutionLease(
      "d".repeat(64),
      {
        ownerPluginId: "ep-api",
        ownerVersion: "1.0.0",
        generationId: "generation-a",
        appSessionId: "window-d",
        ...secondLogin,
      },
    )).rejects.toThrow("indeterminate");
  });
});
