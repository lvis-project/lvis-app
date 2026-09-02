/**
 * Recommended-work proposals — the store half of the plugin → host channel.
 *
 * Same harness as `work-board-store.test.ts`: a temp `board.json` through the
 * constructor (proposals land beside it) and an injectable clock, so the real
 * `~/.lvis/work-board/` namespace is never touched.
 *
 * The rules under test are the ones that have to REFUSE something, because a
 * rule with no test for its refusal is a rule that is documented rather than
 * implemented:
 *   - an undeclared kind is rejected;
 *   - a second open proposal in a kind that already has one is refused;
 *   - a withdrawal by a plugin that does not own the proposal is refused;
 *   - a malformed payload is rejected by field name, never coerced;
 *   - proposals survive a restart.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PROPOSAL_TTL_MAX_MS, PROPOSAL_TTL_MIN_MS } from "../../shared/work-board-types.js";
import type { WorkProposalInput } from "../../shared/work-board-types.js";

const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");

function tempStore(now: () => number = () => FIXED_NOW) {
  const dir = mkdtempSync(join(tmpdir(), "lvis-wbp-"));
  const path = join(dir, "board.json");
  return {
    dir,
    path,
    store: new WorkBoardStore(path, now),
    cleanup: () => cleanupTmpDir(dir),
  };
}

const INDEXER = {
  pluginId: "indexer",
  pluginLabel: "Indexer",
  grantedKinds: ["stale-index", "embed-failed"] as const,
};

function input(overrides: Partial<WorkProposalInput> = {}): WorkProposalInput {
  return {
    kind: "stale-index",
    key: "folder:reports",
    title: "Re-index the reports folder",
    summary: "18 files changed since the last scan.",
    state: "Last scanned 12 days ago; 18 files newer than the index.",
    evidence: [{ label: "Newest change", detail: "quarterly-summary.docx" }],
    blockers: [{ reason: "The folder is on a disconnected share", resolution: "Reconnect the share" }],
    taskBrief: "Re-run the folder scan for the reports folder and report what changed.",
    ...overrides,
  };
}

describe("WorkBoardStore — proposal lifecycle", () => {
  it("posts a proposal, lists it live, and refreshes it in place on the same key", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await store.upsertProposal(INDEXER, input());
      expect(posted.status).toBe("ok");
      if (posted.status !== "ok") return;
      // Identity and label are the HOST's: the payload named neither.
      expect(posted.proposal.pluginId).toBe("indexer");
      expect(posted.proposal.pluginLabel).toBe("Indexer");
      expect(posted.proposal.id.startsWith("indexer:stale-index:")).toBe(true);
      expect(posted.proposal.id).not.toContain("folder:reports");

      const listed = await store.listProposals();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.proposals).toHaveLength(1);
      expect(listed.proposals[0].title).toBe("Re-index the reports folder");

      const refreshed = await store.upsertProposal(
        INDEXER,
        input({ summary: "26 files changed since the last scan." }),
      );
      expect(refreshed.status).toBe("ok");
      const after = await store.listProposals();
      expect(after.status === "ok" && after.proposals).toHaveLength(1);
      expect(after.status === "ok" && after.proposals[0].summary).toBe(
        "26 files changed since the last scan.",
      );
      // A refresh keeps the original createdAt — it is the same card.
      expect(after.status === "ok" && after.proposals[0].createdAt).toBe(
        posted.proposal.createdAt,
      );
    } finally {
      cleanup();
    }
  });

  it("survives a restart", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      await store.upsertProposal(INDEXER, input());
      const reopened = new WorkBoardStore(path, () => FIXED_NOW);
      const listed = await reopened.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(1);
      expect(listed.status === "ok" && listed.proposals[0].key).toBe("folder:reports");
      // Beside board.json, not inside it.
      expect(JSON.parse(readFileSync(join(path, "..", "proposals.json"), "utf8")).proposals)
        .toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("sweeps a proposal whose TTL has run out", async () => {
    let now = FIXED_NOW;
    const { store, cleanup } = tempStore(() => now);
    try {
      await store.upsertProposal(INDEXER, input({ ttlMs: PROPOSAL_TTL_MIN_MS }));
      expect((await store.listProposals()).status).toBe("ok");
      now = FIXED_NOW + PROPOSAL_TTL_MIN_MS + 1;
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("clamps a TTL outside the host's window instead of honouring it", async () => {
    const { store, cleanup } = tempStore();
    try {
      const short = await store.upsertProposal(INDEXER, input({ ttlMs: 1 }));
      expect(short.status === "ok" && Date.parse(short.proposal.expiresAt)).toBe(
        FIXED_NOW + PROPOSAL_TTL_MIN_MS,
      );
      const long = await store.upsertProposal(
        INDEXER,
        input({ key: "folder:archive", kind: "embed-failed", ttlMs: 10 * PROPOSAL_TTL_MAX_MS }),
      );
      expect(long.status === "ok" && Date.parse(long.proposal.expiresAt)).toBe(
        FIXED_NOW + PROPOSAL_TTL_MAX_MS,
      );
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — proposal refusals", () => {
  it("rejects a kind the plugin never declared", async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await store.upsertProposal(INDEXER, input({ kind: "reply-needed" }));
      expect(result).toEqual({ status: "kind_not_granted", kind: "reply-needed" });
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("rejects a kind that is granted to a DIFFERENT plugin", async () => {
    const { store, cleanup } = tempStore();
    try {
      const mail = { pluginId: "mail", pluginLabel: "Mail", grantedKinds: ["reply-needed"] };
      // `stale-index` is a real kind — it just is not this caller's.
      const result = await store.upsertProposal(mail, input({ kind: "stale-index" }));
      expect(result).toEqual({ status: "kind_not_granted", kind: "stale-index" });
    } finally {
      cleanup();
    }
  });

  it("refuses a SECOND open proposal in a kind that already has one", async () => {
    const { store, cleanup } = tempStore();
    try {
      expect((await store.upsertProposal(INDEXER, input())).status).toBe("ok");
      const second = await store.upsertProposal(INDEXER, input({ key: "folder:invoices" }));
      expect(second).toEqual({ status: "slot_busy", kind: "stale-index" });
      // The other declared kind is a separate slot and stays open.
      const otherKind = await store.upsertProposal(
        INDEXER,
        input({ kind: "embed-failed", key: "doc:42" }),
      );
      expect(otherKind.status).toBe("ok");
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("frees the slot once the plugin withdraws, and not before", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.upsertProposal(INDEXER, input());
      expect((await store.upsertProposal(INDEXER, input({ key: "folder:invoices" }))).status)
        .toBe("slot_busy");
      expect(await store.withdrawProposal("indexer", "stale-index", "folder:reports")).toBe(true);
      expect((await store.upsertProposal(INDEXER, input({ key: "folder:invoices" }))).status)
        .toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("refuses a withdrawal from a plugin that does not own the proposal", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.upsertProposal(INDEXER, input());
      // Same kind, same key, different caller — the id it resolves to is
      // derived from ITS OWN plugin id, so the victim's row is not addressable.
      expect(await store.withdrawProposal("mail", "stale-index", "folder:reports")).toBe(false);
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(1);
      // The owner can still withdraw it.
      expect(await store.withdrawProposal("indexer", "stale-index", "folder:reports")).toBe(true);
      // And a second withdrawal is a no-op, not an error.
      expect(await store.withdrawProposal("indexer", "stale-index", "folder:reports")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a malformed payload by field name rather than defaulting it", async () => {
    const { store, cleanup } = tempStore();
    try {
      const cases: Array<[Partial<WorkProposalInput>, string]> = [
        [{ title: "   " }, "title"],
        [{ summary: "" }, "summary"],
        [{ state: "" }, "state"],
        [{ taskBrief: "" }, "taskBrief"],
        [{ kind: "Stale-Index" }, "kind"],
        [{ key: "" }, "key"],
        [{ dueAt: "not-a-date" }, "dueAt"],
        [{ evidence: [{ label: "only a label" } as never] }, "evidence"],
        [{ blockers: [{ reason: "" } as never] }, "blockers"],
        [{ priority: "urgent" as never }, "priority"],
      ];
      for (const [override, field] of cases) {
        const result = await store.upsertProposal(INDEXER, input(override));
        expect(result).toEqual({ status: "invalid", field });
      }
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("keeps a dismissed card closed through a re-post", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await store.upsertProposal(INDEXER, input());
      if (posted.status !== "ok") throw new Error("expected the post to succeed");
      expect((await store.dismissProposal(posted.proposal.id)).status).toBe("dismissed");
      expect((await store.listProposals()).status === "ok").toBe(true);
      expect((await store.listProposals() as { proposals: unknown[] }).proposals).toHaveLength(0);

      // Re-posting the SAME key refreshes the record but must not put the card
      // the user closed back in front of them.
      expect((await store.upsertProposal(INDEXER, input({ summary: "still stale" }))).status)
        .toBe("ok");
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — accepting a proposal", () => {
  it("promotes it through the ordinary create path and closes the card", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await store.upsertProposal(INDEXER, input({ priority: "high" }));
      if (posted.status !== "ok") throw new Error("expected the post to succeed");

      const accepted = await store.acceptProposal(posted.proposal.id, {
        projectRoot: "/tmp/project",
        projectName: "project",
      });
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") return;
      expect(accepted.item.title).toBe("Re-index the reports folder");
      expect(accepted.item.priority).toBe("high");
      expect(accepted.item.status).toBe("planned");
      expect(accepted.item.projectRoot).toBe("/tmp/project");
      // The HOST composed the detail out of state + evidence + blockers, so the
      // shape does not depend on how a plugin laid its text out.
      expect(accepted.item.detail).toContain("Last scanned 12 days ago");
      expect(accepted.item.detail).toContain("Newest change: quarterly-summary.docx");
      expect(accepted.item.detail).toContain("disconnected share → Reconnect the share");
      // `taskBrief` is instruction text for the run, not something to render.
      expect(accepted.item.detail).not.toContain("Re-run the folder scan");

      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("reports not_found for an id that is not open", async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await store.acceptProposal("indexer:stale-index:deadbeefdeadbeef");
      expect(result).toEqual({
        status: "not_found",
        proposalId: "indexer:stale-index:deadbeefdeadbeef",
      });
    } finally {
      cleanup();
    }
  });
});
