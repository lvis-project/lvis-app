/**
 * SkillApprovalsStore — R2-CR-3 hash-binding regression coverage.
 *
 * The pre-fix store keyed approvals by NAME ONLY. A user could approve a
 * benign body once, the file could be swapped after, and the next
 * `skill_load` would short-circuit without re-prompting. After R2-CR-3,
 * approvals are bound to sha256(body) — a body swap forces re-approval.
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SkillApprovalsStore, hashSkillMaterial } from "../skill-approvals-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { observeFileHandleSyncs } from "../../__tests__/support/fsync-observer.js";

const tmpDirs: string[] = [];

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-skill-approvals-"));
  tmpDirs.push(dir);
  return join(dir, "skill-approvals.json");
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await cleanupTmpDir(dir);
  }
});

describe("SkillApprovalsStore — R2-CR-3 hash-binding", () => {
  it("approve(name, body) → isApproved(name, body) returns true for the same body", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v1")).toBe(true);
  });

  it("isApproved returns FALSE when the body has been swapped post-approval", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    // Same name, different body — TOCTOU bypass scenario. Must re-prompt.
    expect(await store.isApproved("report-writing", "body-v2-malicious")).toBe(
      false,
    );
  });

  it("re-approve after body swap rebinds the hash so subsequent isApproved succeeds", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v2")).toBe(false);
    await store.approve("report-writing", "body-v2");
    expect(await store.isApproved("report-writing", "body-v2")).toBe(true);
    // The previous body is no longer approved.
    expect(await store.isApproved("report-writing", "body-v1")).toBe(false);
  });

  it("treats v1-format files (string array) as un-approved (force re-prompt on migration)", async () => {
    const file = tmpFile();
    // Synthesize a v1 record on disk.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        approvedSkills: ["report-writing"],
        approvedAt: { "report-writing": "2026-01-01T00:00:00.000Z" },
      }),
      "utf-8",
    );
    const store = new SkillApprovalsStore(file);
    // v1 records have no sha256 → must force re-prompt regardless of body.
    expect(await store.isApproved("report-writing", "anything")).toBe(false);
  });

  it("treats v2 records missing sha256 as un-approved (defense in depth)", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        approvedSkills: [
          { name: "report-writing", approvedAt: "2026-01-01T00:00:00.000Z" },
          // Note: no sha256 field.
        ],
      }),
      "utf-8",
    );
    const store = new SkillApprovalsStore(file);
    expect(await store.isApproved("report-writing", "anything")).toBe(false);
  });

  it("persists v2 schema with sha256 and approvedAt on approve()", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "hello body");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as {
      version: number;
      approvedSkills: Array<{ name: string; sha256: string; approvedAt: string }>;
    };
    expect(onDisk.version).toBe(2);
    expect(onDisk.approvedSkills).toHaveLength(1);
    expect(onDisk.approvedSkills[0].name).toBe("report-writing");
    expect(onDisk.approvedSkills[0].sha256).toBe(hashSkillMaterial("hello body"));
    expect(typeof onDisk.approvedSkills[0].approvedAt).toBe("string");
  });
});

describe("SkillApprovalsStore — atomic-write convergence (feature-namespace authority)", () => {
  it("does not write through a symlink planted at the predictable ${file}.tmp staging path", async () => {
    // Pre-convergence, writeAtomic staged into a FIXED `${filePath}.tmp`. An
    // attacker who can create that sibling plants a symlink there; the old
    // `writeFile` follows it, so the approval JSON lands at the attacker's
    // destination and the live path is left a symlink. The authority stages
    // into a random name opened with O_CREAT|O_EXCL, so the planted path is
    // never touched.
    const file = tmpFile();
    const outside = join(join(file, ".."), "attacker-owned.json");
    writeFileSync(outside, "");
    symlinkSync(outside, `${file}.tmp`);

    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");

    // Both outcomes below fail if the write had followed the planted symlink:
    // a redirected write leaves `outside` holding the approval JSON (so the
    // first assertion catches it) and `file` a symlink to that now-populated
    // `outside`; a redirected write to the ORIGINAL empty `outside` instead
    // leaves `file` a symlink to an empty target, so reading `file` yields "" and
    // the JSON.parse throws. Only a safe write — staged into a random O_EXCL name
    // and renamed onto `file` — leaves `outside` empty AND `file` a real regular
    // file with the record. (No lstat-then-read on `file`: that check-then-use
    // pair is a file-system-race pattern, and the two reads already pin the
    // guarantee without it.)
    expect(readFileSync(outside, "utf-8")).toBe("");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as {
      approvedSkills: Array<{ name: string; sha256: string }>;
    };
    expect(onDisk.approvedSkills[0].name).toBe("report-writing");
    expect(onDisk.approvedSkills[0].sha256).toBe(hashSkillMaterial("body-v1"));
  });

  it("fsyncs the staged bytes before commit (durability the store's comment claims)", async () => {
    // Pre-convergence used `writeFile`+`rename` with no fsync, so a crash after
    // rename could still lose the bytes. The authority opens the staging file
    // and calls handle.sync() before renaming. Count those sync() calls: 0 with
    // the old code, >=1 (file + parent dir on POSIX) after convergence.
    const file = tmpFile();
    const observer = observeFileHandleSyncs();
    try {
      const store = new SkillApprovalsStore(file);
      await store.approve("report-writing", "body-v1");
    } finally {
      observer.restore();
    }
    expect(existsSync(file)).toBe(true);
    expect(observer.calls()).toBeGreaterThanOrEqual(1);
  });
});

describe("SkillApprovalsStore — corrupt file recovery", () => {
  it("backs up corrupt JSON as .corrupt-<ts>.bak and starts empty", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ this is not json", "utf-8");
    const store = new SkillApprovalsStore(file);

    expect(await store.isApproved("report-writing", "body-v1")).toBe(false);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v1")).toBe(true);

    const backups = readdirSync(dirname(file)).filter((f) => /\.corrupt-\d+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
  });
});
