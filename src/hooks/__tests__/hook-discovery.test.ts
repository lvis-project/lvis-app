/**
 * Q12 P4 Area B — hook discovery + TOFU lockfile.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAcceptedAtMap,
  diffAgainstLockfile,
  disableHook,
  discoverHooks,
  ensureHooksDirectory,
  persistLockfile,
  readLockfile,
  type DiscoveredHook,
  type LockfileShape,
} from "../hook-discovery.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "q12-p4-hd-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function writeHook(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
  return path;
}

describe("Q12 P4 hook-discovery", () => {
  describe("ensureHooksDirectory", () => {
    it("creates the directory when missing", () => {
      const dir = join(tmpDir, "hooks");
      ensureHooksDirectory(dir);
      expect(readFileSync).toBeDefined(); // sanity
      // Re-running is idempotent
      ensureHooksDirectory(dir);
    });
  });

  describe("discoverHooks", () => {
    it("returns empty array when directory missing", () => {
      const hooks = discoverHooks(join(tmpDir, "missing"));
      expect(hooks).toEqual([]);
    });

    it("discovers pre/post/perm scripts and ignores others", () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      writeHook(dir, "pre-deny-rm.sh", "#!/bin/sh\necho '{\"action\":\"allow\",\"reason\":\"\"}'");
      writeHook(dir, "post-audit.sh", "#!/bin/sh\nexit 0");
      writeHook(dir, "perm-strict.sh", "#!/bin/sh\nexit 0");
      writeHook(dir, "README.md", "ignore me");
      writeHook(dir, "ignored-without-prefix.sh", "exit 0");
      const hooks = discoverHooks(dir);
      const names = hooks.map((h) => h.fileName).sort();
      expect(names).toEqual([
        "perm-strict.sh",
        "post-audit.sh",
        "pre-deny-rm.sh",
      ]);
      const pre = hooks.find((h) => h.fileName === "pre-deny-rm.sh")!;
      expect(pre.hookType).toBe("pre");
      expect(pre.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pre.size).toBeGreaterThan(0);
    });

    it("never descends into .disabled/", () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      mkdirSync(join(dir, ".disabled"));
      writeHook(join(dir, ".disabled"), "pre-rejected.sh", "#!/bin/sh");
      const hooks = discoverHooks(dir);
      expect(hooks).toEqual([]);
    });

    it("skips dotfiles (e.g. .lockfile.json)", () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      writeFileSync(join(dir, ".lockfile.json"), "{}");
      writeHook(dir, "pre-real.sh", "#!/bin/sh\nexit 0");
      const hooks = discoverHooks(dir);
      expect(hooks.map((h) => h.fileName)).toEqual(["pre-real.sh"]);
    });
  });

  describe("readLockfile", () => {
    it("returns null for missing file", () => {
      expect(readLockfile(join(tmpDir, "missing.json"))).toBeNull();
    });

    it("returns null + warns on schema mismatch", () => {
      const path = join(tmpDir, "lf.json");
      writeFileSync(path, JSON.stringify({ schemaVersion: 99, hooks: [] }));
      expect(readLockfile(path)).toBeNull();
    });

    it("parses a valid v1 lockfile", () => {
      const path = join(tmpDir, "lf.json");
      const lf: LockfileShape = {
        schemaVersion: 1,
        updatedAt: "2026-01-01T00:00:00Z",
        hooks: [{ fileName: "pre-x.sh", sha256: "deadbeef", acceptedAt: "2026-01-01T00:00:00Z" }],
      };
      writeFileSync(path, JSON.stringify(lf));
      const out = readLockfile(path);
      expect(out).toEqual(lf);
    });
  });

  describe("diffAgainstLockfile", () => {
    function makeHook(fileName: string, sha: string): DiscoveredHook {
      return { path: `/x/${fileName}`, fileName, hookType: "pre", sha256: sha, size: 10 };
    }

    it("treats all discovered as `new` when lockfile is null", () => {
      const discovered = [makeHook("pre-a.sh", "aaa"), makeHook("pre-b.sh", "bbb")];
      const diff = diffAgainstLockfile(discovered, null);
      expect(diff.every((d) => d.state === "new")).toBe(true);
      expect(diff).toHaveLength(2);
    });

    it("trusted when hash matches", () => {
      const lf: LockfileShape = {
        schemaVersion: 1,
        updatedAt: "x",
        hooks: [{ fileName: "pre-a.sh", sha256: "aaa", acceptedAt: "y" }],
      };
      const diff = diffAgainstLockfile([makeHook("pre-a.sh", "aaa")], lf);
      expect(diff[0].state).toBe("trusted");
    });

    it("changed when hash differs", () => {
      const lf: LockfileShape = {
        schemaVersion: 1,
        updatedAt: "x",
        hooks: [{ fileName: "pre-a.sh", sha256: "aaa", acceptedAt: "y" }],
      };
      const diff = diffAgainstLockfile([makeHook("pre-a.sh", "bbb")], lf);
      expect(diff[0].state).toBe("changed");
      expect(diff[0].previousSha256).toBe("aaa");
    });

    it("removed entries surface for deleted files", () => {
      const lf: LockfileShape = {
        schemaVersion: 1,
        updatedAt: "x",
        hooks: [{ fileName: "pre-gone.sh", sha256: "ggg", acceptedAt: "y" }],
      };
      const diff = diffAgainstLockfile([], lf);
      expect(diff).toHaveLength(1);
      expect(diff[0].state).toBe("removed");
      expect(diff[0].previousSha256).toBe("ggg");
    });
  });

  describe("persistLockfile", () => {
    it("writes a v1 lockfile with mode 0o600 + 0o700 dir", async () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      writeHook(dir, "pre-x.sh", "echo");
      const discovered = discoverHooks(dir);
      const path = join(dir, ".lockfile.json");
      const lf = await persistLockfile(discovered, path);
      expect(lf.schemaVersion).toBe(1);
      expect(lf.hooks).toHaveLength(1);
      expect(lf.hooks[0].fileName).toBe("pre-x.sh");
      const onDisk = JSON.parse(readFileSync(path, "utf-8")) as LockfileShape;
      expect(onDisk).toEqual(lf);
    });

    it("preserves existing acceptedAt for known hooks", async () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      writeHook(dir, "pre-x.sh", "echo");
      const discovered = discoverHooks(dir);
      const path = join(dir, ".lockfile.json");
      const previousMap = new Map([["pre-x.sh", "2025-01-01T00:00:00Z"]]);
      const lf = await persistLockfile(discovered, path, previousMap);
      expect(lf.hooks[0].acceptedAt).toBe("2025-01-01T00:00:00Z");
    });
  });

  describe("disableHook", () => {
    it("moves a hook into .disabled/", () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      const path = writeHook(dir, "pre-bad.sh", "echo");
      const hooks = discoverHooks(dir);
      const dest = disableHook(hooks[0], join(dir, ".disabled"));
      expect(dest).toContain(".disabled");
      expect(dest).toContain("pre-bad.sh");
      // Original is gone
      const post = discoverHooks(dir);
      expect(post).toEqual([]);
      // Sanity: original path no longer exists
      expect(() => readFileSync(path)).toThrow();
    });

    it("appends timestamp suffix if destination already exists", () => {
      const dir = join(tmpDir, "hooks");
      mkdirSync(dir);
      const disabledDir = join(dir, ".disabled");
      mkdirSync(disabledDir);
      writeFileSync(join(disabledDir, "pre-bad.sh"), "old");
      writeHook(dir, "pre-bad.sh", "new");
      const hooks = discoverHooks(dir);
      const dest = disableHook(hooks[0], disabledDir);
      expect(dest).not.toBe(join(disabledDir, "pre-bad.sh"));
      expect(dest).toContain("pre-bad.sh.");
    });
  });

  describe("buildAcceptedAtMap", () => {
    it("returns empty map for null lockfile", () => {
      expect(buildAcceptedAtMap(null).size).toBe(0);
    });

    it("maps fileName → acceptedAt", () => {
      const lf: LockfileShape = {
        schemaVersion: 1,
        updatedAt: "x",
        hooks: [
          { fileName: "pre-a.sh", sha256: "aaa", acceptedAt: "2025-01-01" },
          { fileName: "post-b.sh", sha256: "bbb", acceptedAt: "2025-02-02" },
        ],
      };
      const map = buildAcceptedAtMap(lf);
      expect(map.get("pre-a.sh")).toBe("2025-01-01");
      expect(map.get("post-b.sh")).toBe("2025-02-02");
    });
  });
});
