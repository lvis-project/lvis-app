/**
 * Tests for R-2 user-approval-store.
 * Issue: #691 PR-A4
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// Point LVIS_HOME at an isolated temp dir so tests don't touch ~/.lvis
const TEST_HOME = join(tmpdir(), `lvis-test-ua-${randomBytes(4).toString("hex")}`);

// Must set env before importing the module
process.env.LVIS_HOME = TEST_HOME;

import {
  recordApproval,
  lookupApproval,
  revokeApproval,
  revokeApprovalByKey,
  listApprovals,
  readApprovals,
  canonicalStringify,
  __resetSessionStoreForTest,
} from "../user-approval-store.js";

beforeEach(async () => {
  await mkdir(TEST_HOME, { recursive: true });
  __resetSessionStoreForTest();
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  __resetSessionStoreForTest();
});

describe("recordApproval + lookupApproval (session scope)", () => {
  it("returns the entry on lookup after recording (session)", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    const hit = await lookupApproval("bash_run", '{"command":"ls"}', "user-keyboard");
    expect(hit).not.toBeNull();
    expect(hit!.scope).toBe("session");
    expect(hit!.verdictAtApproval).toBe("medium");
    expect(hit!.revokedAt).toBeNull();
  });

  it("returns null for unknown triple", async () => {
    const miss = await lookupApproval("bash_run", '{"command":"rm"}', "user-keyboard");
    expect(miss).toBeNull();
  });

  it("does NOT write to disk for session scope", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    // readApprovals reads disk only — session entry must not appear
    const file = await readApprovals();
    expect(Object.keys(file.approvals)).toHaveLength(0);
  });
});

describe("recordApproval + lookupApproval (persistent scope)", () => {
  it("writes to disk and returns entry on lookup", async () => {
    await recordApproval("memory_write", '{"content":"x"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const file = await readApprovals();
    expect(Object.keys(file.approvals)).toHaveLength(1);

    const hit = await lookupApproval("memory_write", '{"content":"x"}', "builtin");
    expect(hit).not.toBeNull();
    expect(hit!.scope).toBe("persistent");
  });

  it("HIGH verdict with nlJustification persists the justification", async () => {
    await recordApproval("bash_run", '{"command":"rm -rf /tmp/foo"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "high",
      nlJustification: "사용자 요청에 따른 임시 파일 삭제",
    });

    const hit = await lookupApproval("bash_run", '{"command":"rm -rf /tmp/foo"}', "user-keyboard");
    expect(hit?.nlJustification).toBe("사용자 요청에 따른 임시 파일 삭제");
    expect(hit?.verdictAtApproval).toBe("high");
  });
});

describe("revokeApproval", () => {
  it("makes lookupApproval return null after revocation", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    await revokeApproval("bash_run", '{"command":"ls"}', "user-keyboard");

    const result = await lookupApproval("bash_run", '{"command":"ls"}', "user-keyboard");
    expect(result).toBeNull();
  });

  it("is idempotent on unknown triple", async () => {
    // Should not throw
    await expect(revokeApproval("unknown_tool", "{}", "builtin")).resolves.toBeUndefined();
  });
});

describe("revokeApprovalByKey", () => {
  it("marks persistent entry as revoked on disk", async () => {
    await recordApproval("file_read", '{"path":"/tmp/x"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list).toHaveLength(1);
    const key = list[0].key;

    await revokeApprovalByKey(key);

    const file = await readApprovals();
    expect(file.approvals[key].revokedAt).not.toBeNull();
  });
});

describe("listApprovals", () => {
  it("lists active (non-revoked) persistent entries", async () => {
    await recordApproval("file_read", '{"path":"/tmp/a"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.revokedAt === null)).toBe(true);
  });

  it("includes session-only entries in the listing", async () => {
    await recordApproval("mcp_tool", '{}', "mcp", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list.some((a) => a.scope === "session")).toBe(true);
  });

  it("includes revoked entries (revokedAt set) but lookupApproval ignores them", async () => {
    await recordApproval("file_read", '{"path":"/tmp/b"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });
    const list1 = await listApprovals();
    const key = list1[0].key;
    await revokeApprovalByKey(key);

    // listApprovals includes revoked entries for audit purposes (revokedAt set)
    const list2 = await listApprovals();
    const revoked = list2.find((a) => a.key === key);
    expect(revoked).toBeDefined();
    expect(revoked!.revokedAt).not.toBeNull();

    // But lookupApproval skips revoked entries
    const lookup = await lookupApproval("file_read", '{"path":"/tmp/b"}', "builtin");
    expect(lookup).toBeNull();
  });
});

describe("atomicWrite safety", () => {
  it("concurrent writes do not corrupt the file", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      recordApproval(`tool_${i}`, `{"n":${i}}`, "builtin", {
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
      }),
    );
    await Promise.all(writes);

    const file = await readApprovals();
    // At least one write must have landed; JSON must be valid (no corruption)
    expect(typeof file.approvals).toBe("object");
  });
});

// ─── CRITICAL-4: trustOrigin cache identity isolation ─────────────────────────

describe("CRITICAL-4: different trustOrigin values produce distinct cache keys", () => {
  it("approval recorded with trustOrigin A is not visible under trustOrigin B", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "high",
      nlJustification: "user approved",
      trustOrigin: "user-keyboard",
    });

    // Same tool/args/source but different trustOrigin — must not get a hit
    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "plugin-untrusted",
    );
    expect(miss).toBeNull();
  });

  it("approval recorded with trustOrigin is found under same trustOrigin", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
      trustOrigin: "mcp-server-abc",
    });

    const hit = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "mcp-server-abc",
    );
    expect(hit).not.toBeNull();
    expect(hit!.verdictAtApproval).toBe("medium");
  });

  it("approval recorded without trustOrigin is not found when trustOrigin is supplied", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "plugin-abc",
    );
    expect(miss).toBeNull();
  });

  it("different approvalCacheKey values produce distinct cache entries", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      approvalCacheKey: "key-alpha",
    });

    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      undefined,
      "key-beta",
    );
    expect(miss).toBeNull();

    const hit = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      undefined,
      "key-alpha",
    );
    expect(hit).not.toBeNull();
  });
});

// ─── HIGH-2: canonicalStringify key-order invariance ──────────────────────────

describe("HIGH-2: canonicalStringify produces key-order-invariant output", () => {
  it("{a,b} and {b,a} produce the same string", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it("nested objects are also sorted", () => {
    const x = { outer: { z: 3, a: 1 }, b: 2 };
    const y = { b: 2, outer: { a: 1, z: 3 } };
    expect(canonicalStringify(x)).toBe(canonicalStringify(y));
  });

  it("arrays are not reordered (only object keys are sorted)", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("null is handled", () => {
    expect(canonicalStringify(null)).toBe("null");
  });

  it("callers that pre-canonicalize args get key-order-invariant store hits", async () => {
    // The store's public API takes pre-stringified args; key-order invariance is
    // the caller's responsibility (permission-manager.ts uses canonicalStringify
    // before calling lookupApproval). This test verifies that if two callers
    // both use canonicalStringify they get the same canonical string and therefore
    // the same store key.
    const argsObj1 = { path: "/tmp/a", mode: "r" };
    const argsObj2 = { mode: "r", path: "/tmp/a" };
    const canonical1 = canonicalStringify(argsObj1);
    const canonical2 = canonicalStringify(argsObj2);

    // Both canonical forms must be identical
    expect(canonical1).toBe(canonical2);

    // Record using canonical form of argsObj1
    await recordApproval("file_read", canonical1, "builtin", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    // Lookup using canonical form of argsObj2 — must hit
    const hit = await lookupApproval("file_read", canonical2, "builtin");
    expect(hit).not.toBeNull();
  });
});
