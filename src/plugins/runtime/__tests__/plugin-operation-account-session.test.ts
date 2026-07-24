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

function runtime(options: {
  onPluginUiRevisionChange?: (instance: PluginRuntime) => void;
} = {}): PluginRuntime {
  let instance!: PluginRuntime;
  instance = new PluginRuntime({
    hostRoot: "/tmp",
    manifestPaths: [],
    createHostApi: createNoopHostApiForTests,
    onPluginUiRevisionChange: () => options.onPluginUiRevisionChange?.(instance),
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
  return observeFor(instance, pluginId, generationId, toolName, result);
}

function observeFor(
  instance: PluginRuntime,
  targetPluginId: string,
  targetGenerationId: string,
  toolName: string,
  result: unknown,
) {
  const epoch = instance.beginPluginAuthInvocation(
    targetPluginId,
    targetGenerationId,
    toolName,
  );
  return instance.observePluginAuthResult(
    targetPluginId,
    targetGenerationId,
    toolName,
    result,
    epoch?.epoch,
  );
}

function replacementRuntime() {
  return {
    activationId: "generation-2",
    installId: null,
    manifest,
    pluginRoot: "/tmp/session-bound-auth",
    instance: {},
    methods: new Map(),
  };
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

    expect(invocation).toMatchObject({
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
      expect(invocation).toMatchObject({
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

  it("uses one session-bound synthetic operation principal for the governed auth trio", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );

    const status = instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "auth_status",
      "window-1",
    );
    const loginBeforeStart = instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "auth_login",
      "window-1",
    );
    const logout = instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "auth_logout",
      "window-1",
    );

    expect(status).toEqual(loginBeforeStart);
    expect(logout).toEqual(loginBeforeStart);
    expect(instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "auth_login",
      "window-2",
    )).not.toEqual(loginBeforeStart);
    expect(instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "not_auth",
      "window-1",
    )).toBeUndefined();

    const login = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_login",
      "window-1",
    );

    expect(login?.operationAccount).toEqual(loginBeforeStart);
    expect(accountIdentity(instance)).toBeUndefined();
    expect(instance.getPluginAuthOperationAccount(
      pluginId,
      generationId,
      "auth_login",
      "window-1",
    )).toEqual(loginBeforeStart);
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
    }, generationId).publish();
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

  it("captures the latest predecessor account at publish rather than prepare", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "first@example.com" },
    );
    const prepared = instance.prepareRuntimeGeneration({
      activationId: "generation-2",
      installId: null,
      manifest,
      pluginRoot: "/tmp/session-bound-auth",
      instance: {},
      methods: new Map(),
    }, generationId);

    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "latest@example.com" },
    );
    const latestIdentity = accountIdentity(instance);
    prepared.publish();
    expect(accountIdentity(instance)).toBeUndefined();
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: "generation-2",
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);

    expect(
      instance.beginPluginAuthInvocation(
        pluginId,
        "generation-2",
        "auth_login",
      ),
    ).toMatchObject({
      accountTransitionScopeHash: latestIdentity?.identityHash,
      invalidatedAccountHash: latestIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("preserves a late predecessor transition through prepared removal and reinstall", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "first@example.com" },
    );
    const removal = instance.prepareRuntimeRemoval(pluginId, generationId);

    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "latest@example.com" },
    );
    const latestIdentity = accountIdentity(instance);
    removal.publish();
    instance.prepareRuntimeGeneration(replacementRuntime(), generationId).publish();
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: "generation-2",
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);

    expect(
      instance.beginPluginAuthInvocation(
        pluginId,
        "generation-2",
        "auth_login",
      ),
    ).toMatchObject({
      accountTransitionScopeHash: latestIdentity?.identityHash,
      invalidatedAccountHash: latestIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("does not restore a detached predecessor account after prepared publication", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const prepared = instance.prepareRuntimeGeneration(
      replacementRuntime(),
      generationId,
    );
    const status = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_status",
    );
    expect(status).toBeDefined();

    expect(instance.invalidateFailedPluginAuthInvocation(
      pluginId,
      generationId,
      status!.epoch,
    ))
      .toMatchObject({ invalidatedAccountGenerationId: generationId });
    prepared.publish();

    expect(accountIdentity(instance)).toBeUndefined();
  });

  it("preserves another plugin account while publishing this plugin generation", () => {
    const instance = runtime();
    const otherPluginId = "other-session-bound-auth";
    const otherGenerationId = "other-generation-1";
    const otherManifest = { ...manifest, id: otherPluginId };
    instance.setGenerationAccess({
      getActive: vi.fn((id: string) => {
        if (id === pluginId) return { pluginId, generationId, manifest };
        if (id === otherPluginId) {
          return {
            pluginId: otherPluginId,
            generationId: otherGenerationId,
            manifest: otherManifest,
          };
        }
        return undefined;
      }),
      replaceRuntime: vi.fn(),
    } as never);
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "primary@example.com" },
    );
    observeFor(
      instance,
      otherPluginId,
      otherGenerationId,
      "auth_status",
      { authenticated: true, account: "other@example.com" },
    );
    const otherIdentity = instance.getPluginOperationAccountIdentity(
      otherPluginId,
      otherGenerationId,
    );

    instance.prepareRuntimeGeneration(replacementRuntime(), generationId).publish();

    expect(instance.getPluginOperationAccountIdentity(
      otherPluginId,
      otherGenerationId,
    )).toEqual(otherIdentity);
  });

  it("preserves a successor account recorded during publication", () => {
    let activeGenerationId = generationId;
    const instance = runtime({
      onPluginUiRevisionChange: (callbackInstance) => {
        if (activeGenerationId !== "generation-2") return;
        observeFor(
          callbackInstance,
          pluginId,
          activeGenerationId,
          "auth_status",
          { authenticated: true, account: "successor@example.com" },
        );
      },
    });
    instance.setGenerationAccess({
      getActive: vi.fn(() => ({
        pluginId,
        generationId: activeGenerationId,
        manifest,
      })),
      replaceRuntime: vi.fn(),
    } as never);
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "predecessor@example.com" },
    );
    const predecessorIdentity = accountIdentity(instance);
    const prepared = instance.prepareRuntimeGeneration(replacementRuntime(), generationId);

    activeGenerationId = "generation-2";
    prepared.publish();

    expect(accountIdentity(instance)).toBeUndefined();
    expect(instance.getPluginOperationAccountIdentity(pluginId, activeGenerationId)).toMatchObject({
      identityHash: expect.any(String),
      principalHash: expect.any(String),
    });
    expect(instance.getPluginOperationAccountIdentity(pluginId, activeGenerationId))
      .not.toEqual(predecessorIdentity);
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
    }, generationId).publish();
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
    expect(replacementStatus).toBeDefined();

    expect(
      instance.invalidateFailedPluginAuthInvocation(
        pluginId,
        "generation-2",
        replacementStatus!.epoch,
      ),
    ).toEqual({
      invalidatedAccountHash: predecessorIdentity?.principalHash,
      invalidatedAccountGenerationId: generationId,
    });
  });

  it("attributes a replacement unauthenticated status invalidation to the predecessor generation", () => {
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
    }, generationId).publish();
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

  it("attributes an authenticated replacement status invalidation to the predecessor generation", () => {
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
    }, generationId).publish();
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
    const status = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_status",
    );
    expect(status).toBeDefined();

    expect(
      instance.invalidateFailedPluginAuthInvocation(
        pluginId,
        generationId,
        status!.epoch,
      ),
    ).toEqual({
      invalidatedAccountHash: principalHash,
      invalidatedAccountGenerationId: generationId,
    });
    expect(accountIdentity(instance)).toBeUndefined();
  });

  it("revokes a failed status principal even when a newer status has only started", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const principalHash = accountIdentity(instance)?.principalHash;
    const failed = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_status",
    );
    const queuedReplacement = instance.beginPluginAuthInvocation(
      pluginId,
      generationId,
      "auth_status",
    );

    expect(instance.invalidateFailedPluginAuthInvocation(
      pluginId,
      generationId,
      failed!.epoch,
    )).toEqual({
      invalidatedAccountHash: principalHash,
      invalidatedAccountGenerationId: generationId,
    });
    expect(accountIdentity(instance)).toBeUndefined();

    instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
      queuedReplacement?.epoch,
    );
    expect(accountIdentity(instance)?.principalHash).not.toBe(principalHash);
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
