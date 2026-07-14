import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAllowedDirectoryPersist,
  beginWorkspaceRootRemovalPersist,
  completeWorkspaceRootRemovalPersist,
  readPermissionSettings,
  removeAllowedDirectoryPersist,
  writePermissionSettings,
} from "../permission-settings-store.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";

const tempRoots: string[] = [];

function fixture(): { root: string; settings: string } {
  const root = mkdtempSync(join(tmpdir(), "lvis-permission-roots-"));
  tempRoots.push(root);
  return { root, settings: join(root, "settings.json") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace-root settings mutations", () => {
  it("stores a real canonical identity and de-duplicates a lexical alias", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    const child = join(project, "child");
    mkdirSync(child, { recursive: true });
    const alias = join(child, "..");

    const first = await addAllowedDirectoryPersist(alias, settings);
    const second = await addAllowedDirectoryPersist(project, settings);

    expect(first).toEqual([canonicalizePathForMatch(project)]);
    expect(second).toEqual(first);
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual(first);
  });

  it("removes every canonical-equivalent stored alias in one locked mutation", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    const child = join(project, "child");
    const other = join(root, "other");
    mkdirSync(child, { recursive: true });
    mkdirSync(other);
    const alias = join(child, "..");
    await writePermissionSettings(
      { additionalDirectories: [project, alias, other] },
      settings,
    );

    const result = await removeAllowedDirectoryPersist(alias, settings);

    expect(result).toEqual([other]);
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([other]);
  });

  it("serializes concurrent additions without losing either root", async () => {
    const { root, settings } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);

    await Promise.all([
      addAllowedDirectoryPersist(first, settings),
      addAllowedDirectoryPersist(second, settings),
    ]);

    expect(new Set(readPermissionSettings(settings).permissions.additionalDirectories)).toEqual(
      new Set([canonicalizePathForMatch(first), canonicalizePathForMatch(second)]),
    );
  });

  it("serializes a concurrent remove and add without resurrection or lost update", async () => {
    const { root, settings } = fixture();
    const removed = join(root, "removed");
    const added = join(root, "added");
    mkdirSync(removed);
    mkdirSync(added);
    await addAllowedDirectoryPersist(removed, settings);

    await Promise.all([
      removeAllowedDirectoryPersist(removed, settings),
      addAllowedDirectoryPersist(added, settings),
    ]);

    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([
      canonicalizePathForMatch(added),
    ]);
  });

  it("keeps the frozen target identity when a directory alias is retargeted", async () => {
    const { root, settings } = fixture();
    const targetA = join(root, "target-a");
    const targetB = join(root, "target-b");
    const alias = join(root, "alias");
    mkdirSync(targetA);
    mkdirSync(targetB);
    try {
      symlinkSync(targetA, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const stored = await addAllowedDirectoryPersist(alias, settings);
    expect(stored).toEqual([canonicalizePathForMatch(targetA)]);
    unlinkSync(alias);
    symlinkSync(targetB, alias, process.platform === "win32" ? "junction" : "dir");

    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual(stored);
    await removeAllowedDirectoryPersist(stored[0], settings);
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
  });

  it("can remove the frozen target after its original alias becomes broken", async () => {
    const { root, settings } = fixture();
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target);
    try {
      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const [stored] = await addAllowedDirectoryPersist(alias, settings);
    unlinkSync(alias);
    rmSync(target, { recursive: true });

    await removeAllowedDirectoryPersist(stored, settings);
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
  });

  it("atomically cuts an active root over to a durable pending intent", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);

    const begun = await beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings);

    expect(begun).toMatchObject({ created: true, activeDirectories: [] });
    expect(begun?.intent).toMatchObject({
      storedPath: canonicalizePathForMatch(project),
      runtimePath: canonicalizePathForMatch(project),
      source: "workspace-remove-root",
    });
    expect(begun?.intent.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    const persisted = readPermissionSettings(settings).permissions;
    expect(persisted.additionalDirectories).toEqual([]);
    expect(persisted.pendingWorkspaceRootRemovals).toEqual([begun?.intent]);
    await expect(addAllowedDirectoryPersist(project, settings)).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_REMOVAL_PENDING",
    });
  });

  it("converges begin successfully when the atomic rename committed before parent fsync failed", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);
    const realWrite = atomicFile.writeUtf8FileAtomicSync;
    vi.spyOn(atomicFile, "writeUtf8FileAtomicSync").mockImplementationOnce((...args) => {
      realWrite(...args);
      throw Object.assign(new Error("parent fsync failed after rename"), { committed: true });
    });

    const begun = await beginWorkspaceRootRemovalPersist(
      project,
      "workspace-remove-root",
      settings,
    );

    expect(begun).toMatchObject({ created: true, activeDirectories: [] });
    expect(readPermissionSettings(settings).permissions).toMatchObject({
      additionalDirectories: [],
      pendingWorkspaceRootRemovals: [begun!.intent],
    });
  });

  it("converges completion successfully when the atomic rename committed before parent fsync failed", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);
    const begun = await beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings);
    const realWrite = atomicFile.writeUtf8FileAtomicSync;
    vi.spyOn(atomicFile, "writeUtf8FileAtomicSync").mockImplementationOnce((...args) => {
      realWrite(...args);
      throw Object.assign(new Error("parent fsync failed after rename"), { committed: true });
    });

    await expect(
      completeWorkspaceRootRemovalPersist(begun!.intent.operationId, settings),
    ).resolves.toBe(true);
    expect(readPermissionSettings(settings).permissions).toMatchObject({
      additionalDirectories: [],
      pendingWorkspaceRootRemovals: [],
    });
  });

  it("completes only the exact operation id across a remove/re-add/remove ABA", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);
    const first = await beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings);
    expect(await completeWorkspaceRootRemovalPersist(first!.intent.operationId, settings)).toBe(true);
    await addAllowedDirectoryPersist(project, settings);
    const second = await beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings);

    expect(await completeWorkspaceRootRemovalPersist(first!.intent.operationId, settings)).toBe(false);
    expect(readPermissionSettings(settings).permissions.pendingWorkspaceRootRemovals).toEqual([
      second!.intent,
    ]);
  });

  it("fails closed for a present malformed journal instead of reviving active roots", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [project],
        pendingWorkspaceRootRemovals: [{ operationId: "not-a-uuid" }],
      },
    }));

    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
    await expect(
      beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings),
    ).rejects.toThrow("invalid intent");
  });

  it.each([null, "primitive", 7])(
    "fails closed for a non-object pending journal entry: %j",
    (candidate) => {
      const { root, settings } = fixture();
      const project = join(root, "project");
      mkdirSync(project);
      writeFileSync(settings, JSON.stringify({
        permissions: {
          additionalDirectories: [project],
          pendingWorkspaceRootRemovals: [candidate],
        },
      }));

      expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
    },
  );

  it("keeps pending fail-closed when a hand edit reintroduces the active path", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);
    const begun = await beginWorkspaceRootRemovalPersist(project, "workspace-remove-root", settings);
    const intent = begun!.intent;
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [project],
        pendingWorkspaceRootRemovals: [intent],
      },
    }));

    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
    expect(await completeWorkspaceRootRemovalPersist(intent.operationId, settings)).toBe(true);
    expect(readPermissionSettings(settings).permissions).toMatchObject({
      additionalDirectories: [],
      pendingWorkspaceRootRemovals: [],
    });
  });
});
