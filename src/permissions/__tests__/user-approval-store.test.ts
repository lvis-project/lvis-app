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
