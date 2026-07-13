import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeRuntimeAllowedDirectories } from "../allowed-directories.js";
import {
  readPermissionSettings,
  writePermissionSettings,
} from "../permission-settings-store.js";
import { reconcileWorkspaceRoots } from "../workspace-root-reconciler.js";

const cleanupDirs: string[] = [];

function tempSettings(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lvis-root-reconcile-"));
  cleanupDirs.push(dir);
  return { dir, path: join(dir, "settings.json") };
}

async function seed(path: string, roots: string[]): Promise<void> {
  await writePermissionSettings({ additionalDirectories: roots }, path);
}

function codedError(code: string, message = "sensitive filesystem detail"): Error {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileWorkspaceRoots", () => {
  it("keeps a confirmed directory without mutating settings or grants", async () => {
    const { dir, path } = tempSettings();
    await seed(path, [dir]);
    const prunePathGrantsUnderRoot = vi.fn();
    const statFn = vi.fn(async () => ({ isDirectory: () => true }));

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn,
      permissionManager: { prunePathGrantsUnderRoot },
    });

    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([
      expect.objectContaining({ storedPath: dir, reason: "directory" }),
    ]);
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([dir]);
    expect(prunePathGrantsUnderRoot).not.toHaveBeenCalled();
  });

  it("prunes ENOENT using the exact stored spelling and sanitized runtime path for grants", async () => {
    const { dir, path } = tempSettings();
    const storedPath = join(dir, "child", "..");
    const runtimePath = sanitizeRuntimeAllowedDirectories([storedPath])[0]!;
    await seed(path, [storedPath]);
    const prunePathGrantsUnderRoot = vi.fn(async () => [{ pattern: "write_file:path:x" }]);
    const statFn = vi.fn(async () => {
      throw codedError("ENOENT");
    });

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn,
      permissionManager: { prunePathGrantsUnderRoot },
    });

    expect(statFn).toHaveBeenCalledWith(runtimePath);
    expect(prunePathGrantsUnderRoot).toHaveBeenCalledWith(runtimePath, {
      preserveRoots: [],
    });
    expect(result.removed).toEqual([
      { storedPath, runtimePath, reason: "missing", prunedGrants: 1 },
    ]);
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([]);
  });

  it.each([
    ["a successful stat of a file", async () => ({ isDirectory: () => false })],
    ["ENOTDIR", async () => {
      throw codedError("ENOTDIR");
    }],
  ])("prunes a confirmed non-directory: %s", async (_label, statFn) => {
    const { dir, path } = tempSettings();
    await seed(path, [dir]);

    const result = await reconcileWorkspaceRoots({
      source: "list-roots",
      settingsPath: path,
      statFn,
    });

    expect(result.removed[0]).toMatchObject({ storedPath: dir, reason: "not-directory" });
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([]);
  });

  it.each(["EACCES", "EPERM", "EBUSY", "EHOSTUNREACH"])(
    "retains a root on transient %s and audits only stable/redacted details",
    async (code) => {
      const { dir, path } = tempSettings();
      await seed(path, [dir]);
      const auditLog = vi.fn();
      const prunePathGrantsUnderRoot = vi.fn();
      const statFn = vi.fn(async () => {
        throw codedError(code);
      });

      const result = await reconcileWorkspaceRoots({
        source: "boot",
        settingsPath: path,
        statFn,
        permissionManager: { prunePathGrantsUnderRoot },
        auditLogger: { log: auditLog },
      });

      expect(result.retained[0]).toMatchObject({ storedPath: dir, reason: "transient-error", code });
      expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([dir]);
      expect(prunePathGrantsUnderRoot).not.toHaveBeenCalled();
      const serializedAudit = JSON.stringify(auditLog.mock.calls);
      expect(serializedAudit).toContain(code);
      expect(serializedAudit).not.toContain("sensitive filesystem detail");
      expect(serializedAudit).not.toContain(dir);
    },
  );

  it("retains a root when stat exceeds its timeout", async () => {
    const { dir, path } = tempSettings();
    await seed(path, [dir]);
    const statFn = vi.fn(() => new Promise<never>(() => {}));

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn,
      timeoutMs: 5,
    });

    expect(result.retained[0]).toMatchObject({
      storedPath: dir,
      reason: "timeout",
      code: "STAT_TIMEOUT",
    });
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([dir]);
  });

  it("stops timed-out workers without starting additional queued probes", async () => {
    const { dir, path } = tempSettings();
    const roots = Array.from({ length: 5 }, (_, index) => join(dir, "root-" + index));
    await seed(path, roots);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const statFn = vi.fn(() => new Promise<{ isDirectory: () => boolean }>((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        resolve({ isDirectory: () => true });
      });
    }));

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn,
      timeoutMs: 5,
      concurrency: 2,
    });

    expect(statFn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
    expect(active).toBe(2);
    expect(result.retained.filter((root) => root.reason === "timeout")).toHaveLength(2);
    expect(result.retained.filter((root) => root.reason === "unprobed")).toHaveLength(3);
    expect(result.retained.map((root) => root.storedPath)).toEqual(roots);
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual(roots);

    for (const release of releases) release();
    await Promise.resolve();
    expect(active).toBe(0);
  });

  it("bounds concurrent filesystem probes", async () => {
    const { dir, path } = tempSettings();
    const roots = Array.from({ length: 5 }, (_, index) => join(dir, "root-" + index));
    await seed(path, roots);
    let active = 0;
    let maxActive = 0;
    const statFn = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { isDirectory: () => true };
    });

    await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn,
      concurrency: 2,
    });

    expect(maxActive).toBe(2);
    expect(statFn).toHaveBeenCalledTimes(5);
  });


  it("retains a confirmed missing root when durable pre-removal cleanup fails", async () => {
    const { dir, path } = tempSettings();
    await seed(path, [dir]);
    const runtimePath = sanitizeRuntimeAllowedDirectories([dir])[0]!;
    const auditLog = vi.fn();
    const prunePathGrantsUnderRoot = vi.fn(async () => [] as unknown[]);
    const onRemoved = vi.fn(async () => {});
    const beforeRemove = vi.fn(async () => {
      throw codedError("EACCES", "private lifecycle failure at " + dir);
    });

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn: vi.fn(async () => {
        throw codedError("ENOENT");
      }),
      beforeRemove,
      permissionManager: { prunePathGrantsUnderRoot },
      onRemoved,
      auditLogger: { log: auditLog },
    });

    expect(beforeRemove).toHaveBeenCalledWith(runtimePath, {
      globalScopeWasAuthorized: true,
      preserveRoots: [],
    });
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([{
      storedPath: dir,
      runtimePath,
      reason: "persist-error",
      code: "EACCES",
    }]);
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([dir]);
    expect(prunePathGrantsUnderRoot).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
    const serializedAudit = JSON.stringify(auditLog.mock.calls);
    expect(serializedAudit).toContain("lifecycle-prepare-failed");
    expect(serializedAudit).toContain("EACCES");
    expect(serializedAudit).not.toContain("private lifecycle failure");
    expect(serializedAudit).not.toContain(dir);
  });

  it("passes a separately retained child root to parent cleanup and finalization", async () => {
    const { dir, path } = tempSettings();
    const parentRoot = join(dir, "parent");
    const childRoot = join(parentRoot, "child");
    const runtimeParent = sanitizeRuntimeAllowedDirectories([parentRoot])[0]!;
    const runtimeChild = sanitizeRuntimeAllowedDirectories([childRoot])[0]!;
    await seed(path, [parentRoot, childRoot]);
    const beforeRemove = vi.fn(async () => 0);
    const onRemoved = vi.fn(async () => {});

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn: vi.fn(async (candidate) => {
        if (candidate === runtimeParent) throw codedError("ENOENT");
        return { isDirectory: () => true };
      }),
      beforeRemove,
      onRemoved,
    });

    const context = {
      globalScopeWasAuthorized: true,
      preserveRoots: [runtimeChild],
    };
    expect(beforeRemove).toHaveBeenCalledWith(runtimeParent, context);
    expect(onRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ runtimePath: runtimeParent, reason: "missing" }),
      context,
    );
    expect(result.removed).toHaveLength(1);
    expect(result.retained).toEqual([
      expect.objectContaining({ runtimePath: runtimeChild, reason: "directory" }),
    ]);
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([childRoot]);
  });

  it("keeps removal durable when best-effort grant pruning fails without leaking the error", async () => {
    const { dir, path } = tempSettings();
    await seed(path, [dir]);
    const auditLog = vi.fn();
    const prunePathGrantsUnderRoot = vi.fn(async () => {
      throw codedError("EIO", "private grant-store failure");
    });

    const result = await reconcileWorkspaceRoots({
      source: "boot",
      settingsPath: path,
      statFn: vi.fn(async () => {
        throw codedError("ENOENT");
      }),
      permissionManager: { prunePathGrantsUnderRoot },
      auditLogger: { log: auditLog },
    });

    expect(result.removed[0]).toMatchObject({ storedPath: dir, prunedGrants: 0 });
    expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([]);
    const serializedAudit = JSON.stringify(auditLog.mock.calls);
    expect(serializedAudit).toContain("grant-prune-failed");
    expect(serializedAudit).toContain("EIO");
    expect(serializedAudit).not.toContain("private grant-store failure");
  });
});
