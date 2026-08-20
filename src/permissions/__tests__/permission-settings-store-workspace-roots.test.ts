import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const tempRoots: string[] = [];

function fixture(): { root: string; settings: string } {
  const root = mkdtempSync(join(tmpdir(), "lvis-permission-roots-"));
  tempRoots.push(root);
  return { root, settings: join(root, "settings.json") };
}

/**
 * The journal exactly as it sits on disk.
 *
 * Deliberately NOT typed as an array: a damaged file can leave any JSON value
 * under the key, and the point of most of these assertions is which shape
 * survived a write.
 */
function journalOnDisk(settings: string): unknown {
  const parsed = JSON.parse(readFileSync(settings, "utf-8")) as {
    permissions: { pendingWorkspaceRootRemovals: unknown };
  };
  return parsed.permissions.pendingWorkspaceRootRemovals;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    await cleanupTmpDir(root);
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

  it("keeps a root out of the active list when a damaged journal entry still names it", () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    const other = join(root, "other");
    mkdirSync(project);
    mkdirSync(other);
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [project, other],
        // Not actionable as an intent — but it names a root, and that half is
        // readable, so the root it names stays removed.
        pendingWorkspaceRootRemovals: [{ operationId: "not-a-uuid", runtimePath: project }],
      },
    }));

    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([other]);
    expect(read.fault).toMatchObject({ kind: "pending-removals-malformed", entries: 1 });
  });

  it.each([null, "primitive", 7])(
    "leaves the active list alone for a pending journal entry that names nothing: %j",
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

      // This used to answer with an empty list, which the sidebar drew as "you
      // have no projects". An entry that names no root may well BE protecting
      // one — nothing here can tell — but emptying the list would trade every
      // readable grant for one unreadable non-grant while defending nothing:
      // the same hand edit that left the path in the list could have put `[]`
      // here instead, a valid journal that raises no fault and leaves that path
      // just as active. (Only for THAT edit are the two equivalent — an empty
      // journal on its own reactivates nothing, which the sibling test
      // "an emptied journal does not bring a root back" pins.) The fault is how
      // the user is told.
      const read = readPermissionSettings(settings);
      expect(read.permissions.additionalDirectories).toEqual([project]);
      expect(read.fault).toMatchObject({ kind: "pending-removals-malformed", entries: 1 });
    },
  );

  // Pins the scope of the argument above. Emptying the journal is only an
  // equally-easy substitute for an unattributable entry when the path is back
  // in the active list too; on its own it reactivates nothing, because the
  // write that queued the intent dropped the path from `additionalDirectories`
  // at the same time. Stated as a claim next to the code, so it is tested here.
  it("an emptied journal does not bring a root back", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    await addAllowedDirectoryPersist(project, settings);
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toHaveLength(1);

    const begun = await beginWorkspaceRootRemovalPersist(
      project,
      "workspace-remove-root",
      settings,
    );
    expect(begun?.created).toBe(true);
    // The same write that queued the intent already took the path out.
    expect(readPermissionSettings(settings).permissions.additionalDirectories).toEqual([]);
    expect(journalOnDisk(settings)).toHaveLength(1);

    // Hand-clear the journal, the substitute the comment calls equally easy.
    const onDisk = JSON.parse(readFileSync(settings, "utf-8")) as {
      permissions: Record<string, unknown>;
    };
    onDisk.permissions.pendingWorkspaceRootRemovals = [];
    writeFileSync(settings, JSON.stringify(onDisk, null, 2));

    // The root stays gone and nothing is reported: clearing the journal is not
    // a general reactivation.
    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([]);
    expect(read.fault).toBeNull();
  });

  // The one shape where a surviving entry is recognisably a removal INTENT —
  // valid operation id, timestamp, source — and still cannot name its root: the
  // paths are gone, and the active list has the path anyway. Nothing here can
  // name the root that intent was protecting, so the list entry stands. Not the
  // only shape that leaves such a path active — a journal that is not a list at
  // all does too, and names nothing either (see the test below) — only the one
  // where the evidence of an intent survives its subject.
  // Pinned as a test because the alternative to stating the limit is a comment
  // claiming a guarantee this store does not make.
  it("cannot mask a root when a damaged intent lost its paths and the list still has it", () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [project],
        pendingWorkspaceRootRemovals: [{
          operationId: "3f7d0c1a-2b4e-4d8f-9a1c-5e6f70819234",
          storedPath: null,
          runtimePath: null,
          requestedAt: "2026-08-18T00:00:00.000Z",
          source: "workspace-remove-root",
        }],
      },
    }));

    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([project]);
    expect(read.permissions.pendingWorkspaceRootRemovals).toEqual([]);
    expect(read.fault).toMatchObject({ kind: "pending-removals-malformed", entries: 1 });
  });

  it("keeps a journal that is not a list at all, and still answers with the roots", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    const second = join(root, "second");
    mkdirSync(project);
    mkdirSync(second);
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [project],
        // Not a list, so there is no entry to keep apart and the value itself is
        // the thing a write has to put back.
        pendingWorkspaceRootRemovals: "replaced-by-something-outside-the-app",
      },
    }));

    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([project]);
    expect(read.fault).toMatchObject({ kind: "pending-removals-malformed", entries: 1 });

    // An add still succeeds, and it does not touch the key it could not read:
    // that write never names the journal, so the value survives byte for byte
    // in whatever shape it was found.
    const added = await addAllowedDirectoryPersist(second, settings);
    expect(journalOnDisk(settings)).toEqual("replaced-by-something-outside-the-app");

    // A write that DOES rewrite the journal cannot leave a non-array where an
    // array belongs, so it re-seats the unreadable value as one element of the
    // array — after the intent this write decided on — rather than dropping the
    // key. Still preserved, now well-shaped.
    const begun = await beginWorkspaceRootRemovalPersist(
      added[added.length - 1]!,
      "workspace-remove-root",
      settings,
    );
    expect(begun?.created).toBe(true);
    expect(journalOnDisk(settings)).toEqual([
      begun!.intent,
      "replaced-by-something-outside-the-app",
    ]);
  });

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

/**
 * A settings file can be malformed for reasons that have nothing to do with a
 * bug — a hand edit, a restored backup, a half-written predecessor. These
 * drive the real file: they write the damage to disk and then call the same
 * functions the folder picker calls.
 */
describe("a settings file the store cannot fully interpret", () => {
  const VALID_INTENT = {
    operationId: "3f7d0c1a-2b4e-4d8f-9a1c-5e6f70819234",
    storedPath: "",
    runtimePath: "",
    requestedAt: "2026-08-18T00:00:00.000Z",
    source: "workspace-remove-root",
  };

  function corruptedJournalFixture(): {
    settings: string;
    project: string;
    second: string;
    queued: string;
  } {
    const { root, settings } = fixture();
    const project = canonicalizePathForMatch(join(root, "project"));
    const second = canonicalizePathForMatch(join(root, "second"));
    const queued = canonicalizePathForMatch(join(root, "queued"));
    mkdirSync(join(root, "project"));
    mkdirSync(join(root, "second"));
    writeFileSync(settings, JSON.stringify({
      // An unrelated key: a write must never be allowed to drop it.
      appearance: { theme: "dark" },
      permissions: {
        additionalDirectories: [project],
        pendingWorkspaceRootRemovals: [
          { ...VALID_INTENT, storedPath: queued, runtimePath: queued },
          { operationId: "not-a-uuid", storedPath: 7 },
        ],
      },
    }, null, 2));
    return { settings, project, second, queued };
  }

  it("keeps accepting directories while one cleanup entry stays unreadable", async () => {
    const { settings, project, second } = corruptedJournalFixture();

    // The reported symptom was that EVERY add after the corruption failed, for
    // good: two in a row, and the second one after a re-read, is the proof it
    // is not a one-shot that a retry clears.
    expect(await addAllowedDirectoryPersist(second, settings)).toEqual([project, second]);
    const third = join(second, "..", "project");
    expect(await addAllowedDirectoryPersist(third, settings)).toEqual([project, second]);
    expect(readPermissionSettings(settings).permissions.additionalDirectories)
      .toEqual([project, second]);
  });

  it("reports the unreadable entries instead of showing the user an empty project list", () => {
    const { settings, project } = corruptedJournalFixture();

    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([project]);
    expect(read.fault).toEqual({
      kind: "pending-removals-malformed",
      filePath: settings,
      entries: 1,
    });
  });

  it("leaves the unreadable entry on disk verbatim across a write", async () => {
    const { settings, second, queued } = corruptedJournalFixture();
    const before = journalOnDisk(settings);

    await addAllowedDirectoryPersist(second, settings);
    expect(journalOnDisk(settings)).toEqual(before);

    // A write that DOES rewrite the journal still has no standing to drop what
    // it could not read: the new intent joins it, the damaged entry stays.
    const begun = await beginWorkspaceRootRemovalPersist(second, "workspace-remove-root", settings);
    expect(begun?.created).toBe(true);
    expect(journalOnDisk(settings)).toContainEqual({ operationId: "not-a-uuid", storedPath: 7 });

    expect(await completeWorkspaceRootRemovalPersist(begun!.intent.operationId, settings)).toBe(true);
    expect(journalOnDisk(settings)).toEqual([
      { ...VALID_INTENT, storedPath: queued, runtimePath: queued },
      { operationId: "not-a-uuid", storedPath: 7 },
    ]);
    expect((JSON.parse(readFileSync(settings, "utf-8")) as { appearance: unknown }).appearance)
      .toEqual({ theme: "dark" });
  });

  it("still enforces the readable cleanup entries beside the unreadable one", async () => {
    const { settings, queued } = corruptedJournalFixture();

    await expect(addAllowedDirectoryPersist(queued, settings)).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_REMOVAL_PENDING",
    });
    expect(readPermissionSettings(settings).permissions.pendingWorkspaceRootRemovals)
      .toEqual([{ ...VALID_INTENT, storedPath: queued, runtimePath: queued }]);
  });

  // The mirror of the test above, and the limit of that guard: it is handed
  // `journal.intents`, so an entry it could not read names nothing to it while
  // still naming its root to the reader's masking. The add is accepted, and the
  // next read takes the path back out. Written down because the alternative is
  // the comment beside the masking claiming an in-app add cannot reach this
  // state — it can.
  it("accepts an add for a root only the unreadable entry names, then drops it on the next read", async () => {
    const { root, settings } = fixture();
    const project = canonicalizePathForMatch(join(root, "project"));
    mkdirSync(join(root, "project"));
    writeFileSync(settings, JSON.stringify({
      permissions: {
        additionalDirectories: [],
        // An interrupted legacy write: the paths are readable, so the masking
        // honours them, but `source` never landed, so the entry is not
        // actionable as an intent and the add guard never sees it.
        pendingWorkspaceRootRemovals: [{
          operationId: VALID_INTENT.operationId,
          storedPath: project,
          runtimePath: project,
          requestedAt: VALID_INTENT.requestedAt,
        }],
      },
    }, null, 2));

    // Not refused, unlike the readable entry above, and it reaches the file.
    expect(await addAllowedDirectoryPersist(project, settings)).toEqual([project]);
    const onDisk = JSON.parse(readFileSync(settings, "utf-8")) as {
      permissions: { additionalDirectories: string[]; pendingWorkspaceRootRemovals: unknown };
    };
    expect(onDisk.permissions.additionalDirectories).toEqual([project]);

    // The same read that reports the fault drops the path the add returned.
    const read = readPermissionSettings(settings);
    expect(read.permissions.additionalDirectories).toEqual([]);
    expect(read.fault).toMatchObject({ kind: "pending-removals-malformed", entries: 1 });

    // The grant was persisted, so repairing the journal makes it live. That is
    // the other half of the comment's claim, and it is why this is a store that
    // answers yes and then no rather than one that refused. Repair the bytes the
    // add actually left behind, not a fresh file.
    onDisk.permissions.pendingWorkspaceRootRemovals = [];
    writeFileSync(settings, JSON.stringify(onDisk, null, 2));
    const repaired = readPermissionSettings(settings);
    expect(repaired.permissions.additionalDirectories).toEqual([project]);
    expect(repaired.fault).toBeNull();
  });
});

describe("a settings file the store cannot parse at all", () => {
  const DAMAGED = '{ "permissions": { "additionalDirectories": ["/srv/keep"], ';

  it("reports the condition rather than answering with an empty directory list", () => {
    const { settings } = fixture();
    writeFileSync(settings, DAMAGED);

    const read = readPermissionSettings(settings);
    // The gate answer is deny — but it arrives WITH the reason, so a caller
    // that shows projects can tell it apart from a user who has none.
    expect(read.permissions.additionalDirectories).toEqual([]);
    expect(read.fault).toMatchObject({ kind: "file-unreadable", filePath: settings });
    expect(readFileSync(settings, "utf-8")).toBe(DAMAGED);
  });

  it("refuses to write over it instead of replacing the user's document", async () => {
    const { root, settings } = fixture();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(settings, DAMAGED);

    await expect(addAllowedDirectoryPersist(project, settings)).rejects.toMatchObject({
      code: "settings-unreadable",
    });
    // The old write path merged into `{}` here, so this same call used to leave
    // the file holding nothing but the one directory it had just added.
    expect(readFileSync(settings, "utf-8")).toBe(DAMAGED);
  });
});
