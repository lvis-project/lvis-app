import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainPluginInstallLockOperations,
  hasPluginInstallInFlight,
  withPluginInstallLock,
  withAllPluginInstallLocks,
  installMarketplacePluginWithLifecycle,
  rollbackMarketplacePluginWithLifecycle,
} from "../install-lifecycle.js";
import {
  beginAppUpdateInstallRequest,
  clearAppUpdateInstallRequested,
} from "../../main/app-update-install-intent.js";

function makeRuntime(initialPluginIds: string[] = []) {
  let pluginIds = [...initialPluginIds];
  return {
    listPluginIds: vi.fn(() => [...pluginIds]),
    resolvePluginId: vi.fn((pluginId: string) =>
      pluginId.replace(/^lvis-plugin-/, "")
    ),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    resolvePluginInstallIdIfKnown: vi.fn((pluginId: string) => pluginId),
    cancelPendingRestart: vi.fn(),
    activatePreparedArtifact: vi.fn(async (input: {
      manifest: { id: string };
      durableCommit(): Promise<string>;
    }) => {
      const result = await input.durableCommit();
      if (!pluginIds.includes(input.manifest.id)) pluginIds.push(input.manifest.id);
      return { result, retirement: Promise.resolve() };
    }),
    addPlugin: vi.fn(async (pluginId: string) => {
      if (!pluginIds.includes(pluginId)) pluginIds.push(pluginId);
      return "started" as const;
    }),
    waitForPluginReady: vi.fn(async () => {}),
    removePlugin: vi.fn(async (pluginId: string) => {
      pluginIds = pluginIds.filter((id) => id !== pluginId);
    }),
    dropPlugin(pluginId: string) {
      pluginIds = pluginIds.filter((id) => id !== pluginId);
    },
  };
}

function makeMarketplace() {
  let candidateVersion = "2.0.0";
  return {
    list: vi.fn(async () => [
      { id: "p", slug: "lvis-plugin-p", version: "2.0.0" },
      { id: "meeting", slug: "lvis-plugin-meeting", version: "2.0.0" },
    ]),
    install: vi.fn(async (pluginId: string, _onProgress, options) => {
      const canonicalPluginId = pluginId.replace(/^lvis-plugin-/, "");
      await options?.activatePreparedArtifact?.({
        pluginRoot: "/staged/plugin",
        manifest: { id: canonicalPluginId, version: candidateVersion },
        receiptRaw: "{}",
        durableCommit: async () => `${canonicalPluginId}/plugin.json`,
      });
      return { pluginId: canonicalPluginId, installed: true as const };
    }),
    setCandidateVersion(version: string) {
      candidateVersion = version;
    },
    getLiveCatalogVersion: vi.fn(async () => "2.0.0"),
    getInstalledVersion: vi.fn(async () => "1.0.0"),
    quarantinePlugin: vi.fn(async (pluginId: string, reason: string) => ({ pluginId, reason, quarantined: true as const })),
    uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true as const })),
    rollbackPlugin: vi.fn(async (pluginId: string) => ({
      pluginId,
      rolledBackTo: "1.0.0",
    })),
    rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true as const })),
    clearLocalInstallRollback: vi.fn(async () => {}),
  };
}

describe("installMarketplacePluginWithLifecycle", () => {
  afterEach(() => {
    clearAppUpdateInstallRequested();
  });

  it("rejects before touching marketplace state when app update install has started", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    beginAppUpdateInstallRequest();

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("Plugin changes are paused while an app update is installing");

    expect(marketplace.list).not.toHaveBeenCalled();
    expect(marketplace.install).not.toHaveBeenCalled();
    expect(runtime.removePlugin).not.toHaveBeenCalled();
  });

  it("does not enter a plugin install lock callback after app update install starts", async () => {
    const install = vi.fn(async () => undefined);
    beginAppUpdateInstallRequest();

    await expect(withPluginInstallLock("p", install)).rejects.toMatchObject({
      code: "app-update-install-in-progress",
      message: expect.stringContaining("Plugin changes are paused while an app update is installing"),
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("allows a same-plugin lifecycle hook to re-enter its owned lock", async () => {
    const order: string[] = [];
    await expect(withPluginInstallLock("p", async () => {
      order.push("outer:start");
      await withPluginInstallLock("p", async () => {
        order.push("inner");
      });
      order.push("outer:end");
    })).resolves.toBeUndefined();
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  });

  it("keeps the owner lock held until a detached re-entrant mutation settles", async () => {
    const order: string[] = [];
    let releaseInner!: () => void;
    let innerEntered!: () => void;
    const innerGate = new Promise<void>((resolve) => { releaseInner = resolve; });
    const innerStarted = new Promise<void>((resolve) => { innerEntered = resolve; });
    let ownerSettled = false;

    const owner = withPluginInstallLock("p", async () => {
      order.push("owner:start");
      void withPluginInstallLock("p", async () => {
        order.push("inner:start");
        innerEntered();
        await innerGate;
        order.push("inner:end");
      });
      await innerStarted;
      order.push("owner:callback-end");
    }).then(() => { ownerSettled = true; });

    await innerStarted;
    await Promise.resolve();
    expect(ownerSettled).toBe(false);
    expect(order).toEqual(["owner:start", "inner:start", "owner:callback-end"]);

    releaseInner();
    await owner;
    expect(order).toEqual(["owner:start", "inner:start", "owner:callback-end", "inner:end"]);
  });

  it("does not self-deadlock when a re-entrant uninstall drains its own descendants", async () => {
    const order: string[] = [];
    await expect(withPluginInstallLock("p", async () => {
      await withPluginInstallLock("p", async () => {
        order.push("inner:start");
        await drainPluginInstallLockOperations("p");
        order.push("inner:end");
      });
      order.push("outer:end");
    })).resolves.toBeUndefined();
    expect(order).toEqual(["inner:start", "inner:end", "outer:end"]);
  });

  it("does not let an inactive inherited all-plugin token shadow a new plugin lock", async () => {
    const order: string[] = [];
    let inherited!: () => Promise<void>;
    await withAllPluginInstallLocks(async () => {
      inherited = async () => {
        await withPluginInstallLock("p", async () => {
          order.push("plugin");
          await withPluginInstallLock("p", async () => {
            order.push("nested");
          });
        });
      };
    });

    await expect(inherited()).resolves.toBeUndefined();
    expect(order).toEqual(["plugin", "nested"]);
  });

  it("reports detached re-entrant failures to the owning mutation", async () => {
    const detachedFailure = new Error("detached write failed");
    const error = await withPluginInstallLock("p", async () => {
      void withPluginInstallLock("p", async () => {
        throw detachedFailure;
      });
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([detachedFailure]);
  });

  it("preserves the primary owner failure before detached mutation failures", async () => {
    const ownerFailure = new Error("owner failed");
    const detachedFailure = new Error("detached failed");
    const error = await withPluginInstallLock("p", async () => {
      void withPluginInstallLock("p", async () => {
        throw detachedFailure;
      });
      throw ownerFailure;
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([ownerFailure, detachedFailure]);
  });

  it("rejects a per-plugin to all-plugin lock upgrade instead of deadlocking", async () => {
    await expect(withPluginInstallLock("p", async () => {
      await withAllPluginInstallLocks(async () => undefined);
    })).rejects.toThrow("Cannot upgrade a held per-plugin lifecycle lock");
  });

  it("bounds the owner wait while quarantining a detached mutation until it settles", async () => {
    vi.useFakeTimers();
    try {
      let releaseDetached!: () => void;
      let detachedStarted!: () => void;
      let detachedOperation!: Promise<void>;
      const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
      const started = new Promise<void>((resolve) => { detachedStarted = resolve; });
      const owner = withPluginInstallLock("p", async () => {
        detachedOperation = withPluginInstallLock("p", async () => {
          detachedStarted();
          await detachedGate;
        });
        void detachedOperation;
        await started;
      });
      const ownerResult = owner.catch((caught) => caught);
      await started;

      let queuedPluginEntered = false;
      const queuedPlugin = withPluginInstallLock("p", async () => {
        queuedPluginEntered = true;
      });
      const queuedPluginResult = queuedPlugin.catch((caught) => caught);
      let queuedAllEntered = false;
      const queuedAll = withAllPluginInstallLocks(async () => {
        queuedAllEntered = true;
      });
      const queuedAllResult = queuedAll.catch((caught) => caught);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(ownerResult).resolves.toMatchObject({
        code: "plugin-lifecycle-drain-timeout",
      });
      await expect(queuedPluginResult).resolves.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      await expect(queuedAllResult).resolves.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      expect(queuedPluginEntered).toBe(false);
      expect(queuedAllEntered).toBe(false);

      let nextEntered = false;
      const next = withPluginInstallLock("p", async () => {
        nextEntered = true;
      });
      await expect(next).rejects.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      expect(nextEntered).toBe(false);

      releaseDetached();
      await detachedOperation;
      for (let attempt = 0; attempt < 20 && hasPluginInstallInFlight(); attempt += 1) {
        await Promise.resolve();
      }
      expect(hasPluginInstallInFlight()).toBe(false);
      await expect(withPluginInstallLock("p", async () => {
        nextEntered = true;
      })).resolves.toBeUndefined();
      expect(nextEntered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives multi-plugin bootstrap exclusive access across per-plugin mutations", async () => {
    const order: string[] = [];
    let releasePlugin!: () => void;
    let pluginEntered!: () => void;
    const pluginGate = new Promise<void>((resolve) => { releasePlugin = resolve; });
    const pluginStarted = new Promise<void>((resolve) => { pluginEntered = resolve; });
    const pluginMutation = withPluginInstallLock("p", async () => {
      order.push("plugin:start");
      pluginEntered();
      await pluginGate;
      order.push("plugin:end");
    });
    await pluginStarted;

    let releaseAll!: () => void;
    let allEntered!: () => void;
    const allGate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const allStarted = new Promise<void>((resolve) => { allEntered = resolve; });
    const allMutation = withAllPluginInstallLocks(async () => {
      order.push("all:start");
      allEntered();
      await allGate;
      order.push("all:end");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start"]);

    releasePlugin();
    await pluginMutation;
    await allStarted;
    const otherMutation = withPluginInstallLock("other", async () => {
      order.push("other");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start"]);

    releaseAll();
    await allMutation;
    await otherMutation;
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start", "all:end", "other"]);
  });

  it("keeps the loaded generation callable while marketplace patches and atomically starts the installed result", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.install.mockImplementationOnce(async (pluginId: string, onProgress, options) => {
      order.push(`install:${pluginId}`);
      expect(runtime.listPluginIds()).toContain("p");
      onProgress?.({ phase: "verifying" });
      await options?.activatePreparedArtifact?.({
        pluginRoot: "/staged/plugin",
        manifest: { id: "p", version: "2.0.0" },
        receiptRaw: "{}",
        durableCommit: async () => "p/plugin.json",
      });
      return { pluginId: "p", installed: true as const };
    });
    const result = await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      broadcastInstallProgress: ({ phase }) => order.push(`progress:${phase}`),
      emitPluginInstalled: ({ pluginId, source }) => order.push(`installed:${pluginId}:${source}`),
      refreshPluginNotifications: () => order.push("refresh"),
    });

    expect(result).toEqual({ pluginId: "p", installed: true });
    expect(order).toEqual([
      "progress:restarting",
      "progress:installing",
      "install:p",
      "progress:verifying",
      "progress:preparing",
      "progress:registering",
      "installed:p:marketplace",
      "refresh",
    ]);
    expect(runtime.activatePreparedArtifact).toHaveBeenCalledTimes(1);
    expect(runtime.addPlugin).not.toHaveBeenCalled();
  });

  it("uses the canonical catalog id for lifecycle replacement while preserving the requested event slug", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(["meeting"]);
    const marketplace = makeMarketplace();
    marketplace.install.mockImplementationOnce(async (pluginId: string, _onProgress, options) => {
      order.push(`install:${pluginId}`);
      await options?.activatePreparedArtifact?.({
        pluginRoot: "/staged/plugin",
        manifest: { id: "meeting", version: "2.0.0" },
        receiptRaw: "{}",
        durableCommit: async () => "meeting/plugin.json",
      });
      return { pluginId: "meeting", installed: true as const };
    });

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "lvis-plugin-meeting",
      eventSlug: "lvis-plugin-meeting",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      broadcastInstallProgress: ({ slug, phase }) => order.push(`progress:${slug}:${phase}`),
    });

    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(runtime.activatePreparedArtifact).toHaveBeenCalledTimes(1);
    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(order).toEqual([
      "progress:lvis-plugin-meeting:restarting",
      "progress:lvis-plugin-meeting:installing",
      "install:lvis-plugin-meeting",
      "progress:lvis-plugin-meeting:preparing",
      "progress:lvis-plugin-meeting:registering",
    ]);
  });

  it("passes the renderer networkAccess acknowledgement into the marketplace install boundary", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([
      {
        id: "p",
        slug: "lvis-plugin-p",
        version: "2.0.0",
        networkAccess: {
          allowedDomains: ["api.example.com"],
          reasoning: "Syncs data.",
        },
      },
    ]);

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] },
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(marketplace.install).toHaveBeenCalledWith(
      "p",
      expect.any(Function),
      expect.objectContaining({
        networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] },
        activatePreparedArtifact: expect.any(Function),
      }),
    );
  });

  it("does not manufacture a pre-stop for an installed plugin that is not loaded", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([{ id: "p", slug: "lvis-plugin-p", installed: true, version: "2.0.0" }]);

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "lvis-plugin-p",
      eventSlug: "lvis-plugin-p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(runtime.activatePreparedArtifact).toHaveBeenCalledTimes(1);
    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.getLiveCatalogVersion).not.toHaveBeenCalled();
  });

  it("rejects stale renderer expectedVersion before touching runtime or marketplace install", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.getLiveCatalogVersion.mockResolvedValue("1.0.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("version is stale");

    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(marketplace.install).not.toHaveBeenCalled();
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(marketplace.quarantinePlugin).not.toHaveBeenCalled();
  });

  it("checks expectedVersion against the live catalog instead of a stale cached lifecycle list", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([
      { id: "p", slug: "lvis-plugin-p", installed: true, version: "1.0.0" },
    ]);
    marketplace.getLiveCatalogVersion.mockResolvedValue("2.0.0");
    marketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("2.0.0");

    const result = await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      expectedVersion: "2.0.0",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(result).toEqual({ pluginId: "p", installed: true });
    expect(marketplace.getLiveCatalogVersion).toHaveBeenCalledWith("p");
    expect(marketplace.install).toHaveBeenCalledWith(
      "p",
      expect.any(Function),
      expect.objectContaining({
        networkAccessAcknowledgement: undefined,
        activatePreparedArtifact: expect.any(Function),
      }),
    );
  });


  it("rejects a mismatched candidate version before runtime or durable state changes", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    const installed = vi.fn();
    marketplace.setCandidateVersion("1.0.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        emitPluginInstalled: installed,
      }),
    ).rejects.toThrow("version mismatch");

    expect(runtime.activatePreparedArtifact).not.toHaveBeenCalled();
    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(installed).not.toHaveBeenCalled();
  });

  it("keeps the prior runtime generation active when an update candidate version mismatches", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.setCandidateVersion("1.5.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("version mismatch");

    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(runtime.listPluginIds()).toContain("p");
    expect(runtime.activatePreparedArtifact).not.toHaveBeenCalled();
    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(runtime.addPlugin).not.toHaveBeenCalled();
  });

  it("keeps the previously loaded generation when marketplace install fails", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    const log = { warn: vi.fn() };
    marketplace.install.mockRejectedValueOnce(new Error("download failed"));

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        log,
      }),
    ).rejects.toThrow("download failed");

    expect(runtime.listPluginIds()).toContain("p");
    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("treats candidate start failure as an update while retaining the prior generation", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.activatePreparedArtifact.mockRejectedValueOnce(new Error("start failed"));

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("start failed");

    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(runtime.listPluginIds()).toContain("p");
    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(runtime.activatePreparedArtifact).toHaveBeenCalledTimes(1);
    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });
});

describe("rollbackMarketplacePluginWithLifecycle", () => {
  it("routes rollback publication through the immutable runtime activation seam", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.rollbackPlugin.mockImplementationOnce(async (pluginId, options) => {
      await options?.activatePreparedArtifact?.({
        pluginRoot: "/prepared/p",
        manifest: { id: pluginId },
        receiptRaw: "{}",
        durableCommit: async () => "plugins/p/plugin.json",
      });
      return { pluginId, rolledBackTo: "1.0.0" };
    });

    await expect(rollbackMarketplacePluginWithLifecycle({
      pluginId: "p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    })).resolves.toEqual({ pluginId: "p", rolledBackTo: "1.0.0" });

    expect(runtime.activatePreparedArtifact).toHaveBeenCalledOnce();
    expect(marketplace.rollbackPlugin).toHaveBeenCalledWith("p", {
      activatePreparedArtifact: expect.any(Function),
    });
  });

  it("fails closed when marketplace reports a rollback without an active runtime", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();

    await expect(rollbackMarketplacePluginWithLifecycle({
      pluginId: "p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    })).rejects.toThrow("atomic rollback committed without active runtime");
  });
});
