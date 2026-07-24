import { describe, expect, it, vi } from "vitest";
import { createNoopHostApiForTests, PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";

const pluginId = "session-bound-auth";
const generationId = "generation-1";
const manifest: PluginManifest = {
  id: pluginId,
  name: "Session-bound auth",
  version: "1.0.0",
  entry: "index.js",
  description: "test",
  tools: [],
  auth: {
    statusTool: "auth_status",
    loginTool: "auth_login",
    logoutTool: "auth_logout",
  },
};

function runtime(): PluginRuntime {
  const instance = new PluginRuntime({
    hostRoot: "/tmp",
    manifestPaths: [],
    createHostApi: createNoopHostApiForTests,
  });
  instance.setGenerationAccess({
    getActive: vi.fn(() => ({
      pluginId,
      generationId,
      manifest,
    })),
    replaceRuntime: vi.fn(),
  } as never);
  return instance;
}

function accountIdentity(instance: PluginRuntime) {
  return instance.getPluginOperationAccountIdentity(pluginId, generationId);
}

function observe(
  instance: PluginRuntime,
  toolName: string,
  result: unknown,
) {
  const epoch = instance.beginPluginAuthInvocation(
    pluginId,
    generationId,
    toolName,
  );
  return instance.observePluginAuthResult(
    pluginId,
    generationId,
    toolName,
    result,
    epoch?.epoch,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function observeDeferred(
  instance: PluginRuntime,
  toolName: string,
  result: Promise<unknown>,
) {
  const epoch = instance.beginPluginAuthInvocation(
    pluginId,
    generationId,
    toolName,
  );
  return instance.observePluginAuthResult(
    pluginId,
    generationId,
    toolName,
    await result,
    epoch?.epoch,
  );
}

describe("PluginRuntime operation account sessions", () => {
  it("keeps repeated authenticated status stable but rotates after unauthentication", () => {
    const instance = runtime();

    expect(observe(
      instance,
      "auth_status",
      { authenticated: true, account: "Person@Example.com" },
    )).toEqual({});
    const firstIdentity = accountIdentity(instance);
    const first = firstIdentity?.principalHash;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(firstIdentity?.identityHash).toMatch(/^[a-f0-9]{64}$/);

    expect(observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    )).toEqual({});
    expect(accountIdentity(instance)?.principalHash).toBe(first);

    expect(observe(
      instance,
      "auth_status",
      { authenticated: false },
    )).toEqual({
      invalidatedAccountHash: first,
      invalidatedAccountGenerationId: generationId,
    });
    expect(accountIdentity(instance)).toBeUndefined();

    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const secondIdentity = accountIdentity(instance);
    const second = secondIdentity?.principalHash;
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(secondIdentity?.identityHash).toBe(firstIdentity?.identityHash);
  });

  it("invalidates the current account binding on explicit logout", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    const current = accountIdentity(instance)?.principalHash;
    const currentScope = accountIdentity(instance)?.identityHash;
    const invocation = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_logout",
    );

    expect(invocation).toEqual({
      epoch: expect.any(Number),
      accountTransitionScopeHash: currentScope,
      invalidatedAccountHash: current,
      invalidatedAccountGenerationId: generationId,
    });
    expect(instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_logout",
      { success: true },
      invocation?.epoch,
    )).toEqual({});
    expect(accountIdentity(instance)).toBeUndefined();

    observe(
      instance,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    expect(accountIdentity(instance)?.principalHash)
      .not.toBe(current);
  });

  it.each(["auth_login", "auth_logout"] as const)(
    "invalidates the current principal when %s starts and does not restore it from a partial result",
    (toolName) => {
      const instance = runtime();
      observe(
        instance,
        "auth_status",
        { authenticated: true, account: "person@example.com" },
      );
      const current = accountIdentity(instance)?.principalHash;
      const currentScope = accountIdentity(instance)?.identityHash;

      const invocation = instance.beginPluginAuthInvocation(
        pluginId,
        generationId,
        toolName,
      );
      expect(invocation).toEqual({
        epoch: expect.any(Number),
        accountTransitionScopeHash: currentScope,
        invalidatedAccountHash: current,
        invalidatedAccountGenerationId: generationId,
      });
      expect(accountIdentity(instance)).toBeUndefined();
      instance.observePluginAuthResult(
        pluginId,
        generationId,
        toolName,
        toolName === "auth_login" ? { success: true } : { success: false },
        invocation?.epoch,
      );
      expect(accountIdentity(instance)).toBeUndefined();

      const status = instance.beginPluginAuthInvocation(
        pluginId,
        generationId,
        "auth_status",
      );
      instance.observePluginAuthResult(
        pluginId,
        generationId,
        "auth_status",
        { authenticated: true, account: "person@example.com" },
        status?.epoch,
      );
      expect(accountIdentity(instance)?.principalHash)
        .toMatch(/^[a-f0-9]{64}$/);
      expect(accountIdentity(instance)?.principalHash)
        .not.toBe(current);
    },
  );

  it("retains one stable transition scope across concurrent login and logout starts", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const identity = accountIdentity(instance);

    const login = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_login",
    );
    const logout = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_logout",
    );

    expect(login).toMatchObject({
      accountTransitionScopeHash: identity?.identityHash,
      invalidatedAccountHash: identity?.principalHash,
    });
    expect(logout).toMatchObject({
      accountTransitionScopeHash: identity?.identityHash,
      invalidatedAccountHash: identity?.principalHash,
    });
    expect(logout?.epoch).toBeGreaterThan(login?.epoch ?? 0);
  });

  it("uses one plugin-stable transition scope before the first authenticated account", () => {
    const instance = runtime();

    const first = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_login",
    );
    const second = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_login",
    );

    expect(first?.accountTransitionScopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.accountTransitionScopeHash)
      .toBe(first?.accountTransitionScopeHash);
    expect(first?.invalidatedAccountHash).toBeUndefined();
    expect(second?.invalidatedAccountHash).toBeUndefined();
  });

  it("bridges the authenticated transition scope across runtime generation publication", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }).publish();
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: "generation-2",
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);

    const replacement = instance.beginPluginAuthInvocation(
      pluginId,
      "generation-2",
      "auth_login",
    );

    expect(replacement?.accountTransitionScopeHash)
      .toBe(predecessorIdentity?.identityHash);
    expect(replacement).toMatchObject({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("attributes detached replacement auth invalidation to the predecessor generation", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }).publish();

    expect(
      instance.invalidateDetachedPluginAuthInvocation(
        pluginId,
        "generation-2",
      ),
    ).toEqual({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("attributes a replacement auth-status invalidation to the predecessor generation", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }).publish();
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: "generation-2",
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);

    const replacementStatus = instance.beginPluginAuthInvocation(
      pluginId,
      "generation-2",
      "auth_status",
    );
    expect(instance.observePluginAuthResult(
      pluginId,
      "generation-2",
      "auth_status",
      { authenticated: false },
      replacementStatus?.epoch,
    )).toEqual({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("attributes a detached replacement auth handler to the predecessor generation", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }).publish();

    expect(
      instance.invalidateDetachedPluginAuthInvocation(pluginId, "generation-2"),
    ).toEqual({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("attributes replacement status invalidation to the predecessor generation", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }).publish();
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: "generation-2",
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);
    const status = instance.beginPluginAuthInvocation(
      pluginId,
      "generation-2",
      "auth_status",
    );

    expect(
      instance.observePluginAuthResult(
        pluginId,
        "generation-2",
        "auth_status",
        { authenticated: true, account: "person@example.com" },
        status?.epoch,
      ),
    ).toEqual({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("invalidates the cached principal when an auth handler detaches", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const principalHash = accountIdentity(instance)?.principalHash;

    expect(
      instance.invalidateDetachedPluginAuthInvocation(
        pluginId,
        generationId,
      ),
    ).toEqual({
      invalidatedAccountHash: principalHash,
      invalidatedAccountGenerationId: generationId,
    });
    expect(accountIdentity(instance)).toBeUndefined();
  });

  it("ignores an older authenticated status that completes after a newer principal", async () => {
    const instance = runtime();
    const older = deferred<unknown>();
    const olderCompletion = observeDeferred(instance, "auth_status", older.promise);
    const newer = observeDeferred(
      instance,
      "auth_status",
      Promise.resolve({ authenticated: true, account: "newer@example.com" }),
    );

    await newer;
    const newerPrincipal = accountIdentity(instance)?.principalHash;
    older.resolve({ authenticated: true, account: "older@example.com" });
    await olderCompletion;

    expect(accountIdentity(instance)?.principalHash)
      .toBe(newerPrincipal);
  });

  it("ignores stale unauthenticated status and logout completions after a newer principal", async () => {
    const instance = runtime();
    for (const [toolName, result] of [
      ["auth_status", { authenticated: false }],
      ["auth_logout", { success: true }],
    ] as const) {
      const stale = deferred<unknown>();
      const staleCompletion = observeDeferred(instance, toolName, stale.promise);
      await observeDeferred(
        instance,
        "auth_status",
        Promise.resolve({
          authenticated: true,
          account: `${toolName}@example.com`,
        }),
      );
      const newerPrincipal = accountIdentity(instance)?.principalHash;

      stale.resolve(result);
      await staleCompletion;

      expect(accountIdentity(instance)?.principalHash)
        .toBe(newerPrincipal);
    }
  });

  it("keeps the principal invalid after login starts even when an older status completes", async () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "current@example.com" },
    );
    const currentPrincipal = accountIdentity(instance)?.principalHash;
    const staleStatus = deferred<unknown>();
    const staleCompletion = observeDeferred(
      instance,
      "auth_status",
      staleStatus.promise,
    );

    await observeDeferred(
      instance,
      "auth_login",
      Promise.resolve({ success: true }),
    );
    staleStatus.resolve({ authenticated: false });
    await staleCompletion;

    expect(accountIdentity(instance)).toBeUndefined();
    expect(currentPrincipal).toMatch(/^[a-f0-9]{64}$/);
  });
});
