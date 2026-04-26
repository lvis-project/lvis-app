/**
 * SkillApprovalsStore — R2-CR-3 hash-binding regression coverage.
 *
 * The pre-fix store keyed approvals by NAME ONLY. A user could approve a
 * benign body once, the file could be swapped after, and the next
 * `skill_load` would short-circuit without re-prompting. After R2-CR-3,
 * approvals are bound to sha256(body) — a body swap forces re-approval.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillApprovalsStore, hashSkillBody } from "../skill-approvals-store.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-skill-approvals-"));
  return join(dir, "skill-approvals.json");
}

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
    expect(onDisk.approvedSkills[0].sha256).toBe(hashSkillBody("hello body"));
    expect(typeof onDisk.approvedSkills[0].approvedAt).toBe("string");
  });
});
