/**
 * What the session list calls each row.
 *
 * A work-board run is a sub-agent session whose `originSessionId` names a
 * work-board item. The memory manager is the one place that turns that origin
 * into `workBoardItemId`, so the sidebar, the IPC handler and the runner all
 * agree on which sessions are runs — and which are not (a chat's own
 * sub-agents, the briefing runs). `sessionFamilyOf` is the one place that turns
 * a store plus a row into the family the sidebar draws.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, sessionFamilyOf } from "../memory-manager.js";
import {
  isSessionFamily,
  SESSION_FAMILIES,
  type SessionFamily,
} from "../../shared/session-lookup.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  parseWorkBoardOriginSessionId,
  workBoardOriginSessionId,
} from "../../shared/work-board-types.js";

const MAIN = "aaaaaaaa-1111-2222-3333-444444444444";
const RUN = "bbbbbbbb-1111-2222-3333-444444444444";
const BRIEFING = "cccccccc-1111-2222-3333-444444444444";
const CHAT_CHILD = "dddddddd-1111-2222-3333-444444444444";

describe("work-board origin id", () => {
  it("round-trips an item id and rejects everything that is not one", () => {
    expect(workBoardOriginSessionId(12)).toBe("work-board:12");
    expect(parseWorkBoardOriginSessionId(workBoardOriginSessionId(12))).toBe(12);
    expect(parseWorkBoardOriginSessionId("work-board:0")).toBeNull();
    expect(parseWorkBoardOriginSessionId("work-board:-1")).toBeNull();
    expect(parseWorkBoardOriginSessionId("work-board:7x")).toBeNull();
    expect(parseWorkBoardOriginSessionId("work-board:")).toBeNull();
    expect(parseWorkBoardOriginSessionId("work-board-briefing:daily")).toBeNull();
    expect(parseWorkBoardOriginSessionId(MAIN)).toBeNull();
    expect(parseWorkBoardOriginSessionId(undefined)).toBeNull();
    expect(parseWorkBoardOriginSessionId(12)).toBeNull();
  });
});

describe("listSessions with workBoardRuns", () => {
  let dir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lvis-work-board-runs-"));
    mm = new MemoryManager({ lvisDir: dir });
    await mm.saveSession(MAIN, [{ role: "user", content: "hello" }]);
    await mm.saveSessionMetadata(MAIN, { sessionKind: "main" });
    await mm.saveSession(RUN, [{ role: "user", content: "run" }]);
    await mm.saveSessionMetadata(RUN, {
      sessionKind: "subagent",
      originSessionId: workBoardOriginSessionId(12),
      spawnId: "spawn-run",
      subAgentTitle: "Execute: 월간 보고서",
    });
    await mm.saveSession(BRIEFING, [{ role: "user", content: "briefing" }]);
    await mm.saveSessionMetadata(BRIEFING, {
      sessionKind: "subagent",
      originSessionId: "work-board-briefing:daily",
      spawnId: "spawn-briefing",
    });
    await mm.saveSession(CHAT_CHILD, [{ role: "user", content: "child" }]);
    await mm.saveSessionMetadata(CHAT_CHILD, {
      sessionKind: "subagent",
      originSessionId: MAIN,
      spawnId: "spawn-child",
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it("returns only the sub-agent sessions an item spawned, each naming its item", () => {
    const runs = mm.listSessions({ kind: "subagent", workBoardRuns: true });
    expect(runs.map((entry) => entry.id)).toEqual([RUN]);
    expect(runs[0]?.workBoardItemId).toBe(12);
    expect(runs[0]?.sessionKind).toBe("subagent");
  });

  it("pages the same way as the other listings", () => {
    const page = mm.listSessionsPage({ kind: "subagent", workBoardRuns: true, limit: 5 });
    expect(page.map((entry) => entry.id)).toEqual([RUN]);
    expect(page[0]?.workBoardItemId).toBe(12);
  });

  it("does not change the default main listing", () => {
    const main = mm.listSessions();
    expect(main.map((entry) => entry.id)).toEqual([MAIN]);
    expect(main[0]).not.toHaveProperty("workBoardItemId");
  });

  it("lists every sub-agent session without the flag, and only the run carries an item id", () => {
    const all = mm.listSessions({ kind: "subagent" });
    expect(new Set(all.map((entry) => entry.id))).toEqual(new Set([RUN, BRIEFING, CHAT_CHILD]));
    expect(all.find((entry) => entry.id === RUN)?.workBoardItemId).toBe(12);
    expect(all.find((entry) => entry.id === BRIEFING)).not.toHaveProperty("workBoardItemId");
    expect(all.find((entry) => entry.id === CHAT_CHILD)).not.toHaveProperty("workBoardItemId");
  });
});

describe("sessionFamilyOf", () => {
  it("names the family from the store the row came out of plus its metadata", () => {
    expect(sessionFamilyOf("main", { sessionKind: "main" })).toBe("main");
    expect(sessionFamilyOf("main", { sessionKind: "routine" })).toBe("routine");
    expect(sessionFamilyOf("side-chat", { sessionKind: "main" })).toBe("side-chat");
    expect(sessionFamilyOf("subagent", { sessionKind: "subagent", workBoardItemId: 12 })).toBe("work-board");
  });

  it("has no family for a sub-agent that is not an item's run", () => {
    // Those are reachable inside their parent conversation's sub-agent tab;
    // a row beside the conversation would say the same thing twice.
    expect(sessionFamilyOf("subagent", { sessionKind: "subagent" })).toBeNull();
  });

  it("has no family for a kind the main store should not be holding", () => {
    expect(sessionFamilyOf("main", { sessionKind: "subagent" })).toBeNull();
  });
});

describe("the family value set", () => {
  it("names every member of the union, once", () => {
    expect([...SESSION_FAMILIES].sort()).toEqual(["main", "routine", "side-chat", "work-board"]);
    expect(new Set(SESSION_FAMILIES).size).toBe(SESSION_FAMILIES.length);
  });

  it("admits only a family this host has", () => {
    expect(SESSION_FAMILIES.every(isSessionFamily)).toBe(true);
    // A newer renderer naming a family this host does not have is dropped, not
    // refused — the request stays answerable.
    expect(isSessionFamily("subagent")).toBe(false);
    expect(isSessionFamily(undefined)).toBe(false);
    expect(isSessionFamily("toString")).toBe(false);
  });

  it("cannot be built from a short table", () => {
    // The guarantee an array-built `Set<SessionFamily>` did not give: a member
    // added to the union and forgotten in the value set is a COMPILE error
    // here, not a family the request validator silently drops. Delete a key
    // below and this line stops erroring, which fails the gate.
    // @ts-expect-error - "side-chat" is missing
    const incomplete: Readonly<Record<SessionFamily, true>> = {
      "main": true,
      "routine": true,
      "work-board": true,
    };
    expect(Object.keys(incomplete)).toHaveLength(3);
  });
});

describe("originSessionId on a listed row", () => {
  let dir: string;
  let mm: MemoryManager;
  const SIDE = "eeeeeeee-1111-2222-3333-444444444444";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lvis-session-origin-"));
    mm = new MemoryManager({ lvisDir: dir });
    await mm.saveSession(SIDE, [{ role: "user", content: "side" }]);
    await mm.saveSessionMetadata(SIDE, { sessionKind: "main", originSessionId: MAIN });
    await mm.saveSession(MAIN, [{ role: "user", content: "hello" }]);
    await mm.saveSessionMetadata(MAIN, { sessionKind: "main" });
  });

  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it("carries the conversation a session was started from, and nothing when there is none", () => {
    const rows = mm.listSessions({ kind: "all" });
    expect(rows.find((entry) => entry.id === SIDE)?.originSessionId).toBe(MAIN);
    expect(rows.find((entry) => entry.id === MAIN)).not.toHaveProperty("originSessionId");
  });
});
