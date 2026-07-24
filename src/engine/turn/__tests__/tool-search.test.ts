/**
 * Tool-Level Deferral — handleToolSearch pure-logic unit tests.
 *
 * Mirror of the request_plugin intercept semantics one layer down:
 *   - matched catalog tools are promoted into activeToolNames
 *   - a tool_result is synthesized per intercepted tool_use (tool-pair invariant)
 *   - non-tool_search tool_uses pass through as `remaining`
 *   - per-turn / per-session caps are enforced
 *   - missing query / no-match → error tool_result without mutating scope
 */
import { describe, it, expect } from "vitest";

import {
  handleToolSearch,
  TOOL_SEARCH_TOOL,
  MAX_TOOL_SEARCH_PER_TURN,
  MAX_TOOL_SEARCH_PER_SESSION,
  MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH,
  MIN_CATALOG_MATCH_TOKEN_LENGTH,
  _scoreCatalogEntryForTest,
  _computeIdfWeightsForTest,
  type ToolSearchState,
} from "../tool-search.js";
import type { ToolUseBlock } from "../../../tools/executor.js";

function search(id: string, query: unknown): ToolUseBlock {
  return { id, name: TOOL_SEARCH_TOOL, input: { query } };
}

function freshState(overrides: Partial<ToolSearchState> = {}): ToolSearchState {
  return {
    turnSearches: 0,
    sessionSearches: 0,
    activeToolNames: new Set<string>(),
    catalog: [
      { name: "meeting_start", description: "회의 녹음을 시작합니다." },
      { name: "meeting_stop", description: "회의 녹음을 종료합니다." },
      { name: "email_list", description: "받은 메일 목록을 조회합니다." },
    ],
    ...overrides,
  };
}

describe("handleToolSearch", () => {
  it("promotes a matching catalog tool and synthesizes a tool_result", () => {
    const state = freshState();
    const out = handleToolSearch([search("tu-1", "meeting_start")], state);
    expect(out.promotedToolNames).toContain("meeting_start");
    expect(state.activeToolNames.has("meeting_start")).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].tool_use_id).toBe("tu-1");
    expect(out.results[0].is_error).toBe(false);
    expect(out.nextTurnSearches).toBe(1);
    expect(out.nextSessionSearches).toBe(1);
  });

  it("matches by description keyword, not just tool name", () => {
    const state = freshState();
    const out = handleToolSearch([search("tu-1", "메일")], state);
    expect(out.promotedToolNames).toContain("email_list");
  });

  it("passes non-tool_search tool_uses through as remaining", () => {
    const state = freshState();
    const other: ToolUseBlock = { id: "tu-x", name: "bash", input: { command: "ls" } };
    const out = handleToolSearch([search("tu-1", "meeting_start"), other], state);
    expect(out.remaining).toEqual([other]);
  });

  it("returns an error tool_result for a missing/empty query without mutating scope", () => {
    const state = freshState();
    const out = handleToolSearch([search("tu-1", "")], state);
    expect(out.results[0].is_error).toBe(true);
    expect(out.promotedToolNames).toEqual([]);
    expect(state.activeToolNames.size).toBe(0);
    expect(out.nextTurnSearches).toBe(0);
  });

  it("returns an error for query text without a searchable token", () => {
    const state = freshState();
    const out = handleToolSearch([search("tu-1", "m")], state);
    expect(out.results[0].is_error).toBe(true);
    expect(out.results[0].content).toContain(`${MIN_CATALOG_MATCH_TOKEN_LENGTH}글자`);
    expect(out.promotedToolNames).toEqual([]);
    expect(state.activeToolNames.size).toBe(0);
  });

  it("does not promote on a sub-minimum-length token but does on a valid one", () => {
    // Every catalog description contains the single char "e", so a 1-char query
    // would broadly over-promote without the min-token guard. A name token of
    // valid length ("email") must still promote its tool.
    const state = freshState({
      catalog: [
        { name: "meeting_start", description: "begin a recorded meeting" },
        { name: "email_list", description: "enumerate received messages" },
      ],
    });
    const subMin = handleToolSearch([search("tu-1", "e")], state);
    expect(subMin.results[0].is_error).toBe(true);
    expect(subMin.promotedToolNames).toEqual([]);
    expect(state.activeToolNames.size).toBe(0);

    const valid = handleToolSearch([search("tu-2", "email")], state);
    expect(valid.results[0].is_error).toBe(false);
    expect(valid.promotedToolNames).toContain("email_list");
    expect(state.activeToolNames.has("email_list")).toBe(true);
  });

  it("does not let a sub-minimum-length token contribute to scoring", () => {
    // Mixed query: a sub-min token ("a") plus a valid token ("meeting"). Only
    // the valid token may drive promotion — the short token must contribute no
    // score even though it is a substring of every catalog entry.
    const state = freshState({
      catalog: [
        { name: "meeting_start", description: "a meeting helper" },
        { name: "calendar_add", description: "add a calendar event" },
      ],
    });
    const out = handleToolSearch([search("tu-1", "a meeting")], state);
    expect(out.results[0].is_error).toBe(false);
    // calendar_add only matches via the sub-min "a" token → must NOT promote.
    expect(out.promotedToolNames).toEqual(["meeting_start"]);
    expect(state.activeToolNames.has("calendar_add")).toBe(false);
  });

  it("returns an error tool_result when no catalog tool matches", () => {
    const state = freshState();
    const out = handleToolSearch([search("tu-1", "존재하지않는도구xyz")], state);
    expect(out.results[0].is_error).toBe(true);
    expect(out.promotedToolNames).toEqual([]);
  });

  it("returns a non-error already-loaded result for an exact loaded tool query", () => {
    const state = freshState({ activeToolNames: new Set(["meeting_start"]) });
    const out = handleToolSearch([search("tu-1", "meeting_start")], state);
    expect(out.results[0].is_error).toBe(false);
    expect(out.results[0].content).toContain("이미 로드");
    expect(out.promotedToolNames).toEqual([]);
    expect(out.nextTurnSearches).toBe(0);
    expect(out.nextSessionSearches).toBe(0);
  });

  it("recognizes eager-loaded tools even when they were not individually promoted", () => {
    const state = freshState({
      activeToolNames: new Set<string>(),
      loadedToolNames: new Set(["meeting_start"]),
      catalog: [],
    });
    const out = handleToolSearch([search("tu-1", "meeting_start")], state);
    expect(out.results[0].is_error).toBe(false);
    expect(out.results[0].content).toContain("이미 로드");
    expect(out.promotedToolNames).toEqual([]);
    expect(state.activeToolNames.size).toBe(0);
  });

  it("recognizes eager-loaded tools by name tokens when no unloaded catalog tool matches", () => {
    const state = freshState({
      activeToolNames: new Set<string>(),
      loadedTools: [{ name: "index_scan_status", description: "로컬 인덱서 상태 확인" }],
      catalog: [],
    });
    const out = handleToolSearch([search("tu-1", "scan status")], state);
    expect(out.results[0].is_error).toBe(false);
    expect(out.results[0].content).toContain("이미 로드");
    expect(out.promotedToolNames).toEqual([]);
  });

  it("still promotes unloaded catalog matches before falling back to already-loaded keyword matches", () => {
    const state = freshState({
      activeToolNames: new Set<string>(),
      loadedTools: [{ name: "meeting_start", description: "meeting helper" }],
      catalog: [{ name: "meeting_stop", description: "meeting helper" }],
    });
    const out = handleToolSearch([search("tu-1", "meeting")], state);
    expect(out.results[0].is_error).toBe(false);
    expect(out.promotedToolNames).toEqual(["meeting_stop"]);
  });

  it("caps a broad query to a small top-N promotion set", () => {
    const state = freshState({
      catalog: [
        { name: "meeting_agenda", description: "meeting helper" },
        { name: "meeting_notes", description: "meeting helper" },
        { name: "meeting_start", description: "meeting helper" },
        { name: "meeting_stop", description: "meeting helper" },
        { name: "meeting_summary", description: "meeting helper" },
      ],
    });
    const out = handleToolSearch([search("tu-1", "meeting")], state);
    expect(out.results[0].is_error).toBe(false);
    expect(out.promotedToolNames).toHaveLength(MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH);
    expect(state.activeToolNames.size).toBe(MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH);
  });

  it("enforces the per-turn cap", () => {
    const state = freshState({ turnSearches: MAX_TOOL_SEARCH_PER_TURN });
    const out = handleToolSearch([search("tu-1", "meeting_start")], state);
    expect(out.results[0].is_error).toBe(true);
    expect(out.results[0].content).toContain("한도 초과");
    expect(state.activeToolNames.size).toBe(0);
  });

  it("enforces the per-session cap", () => {
    const state = freshState({ sessionSearches: MAX_TOOL_SEARCH_PER_SESSION });
    const out = handleToolSearch([search("tu-1", "meeting_start")], state);
    expect(out.results[0].is_error).toBe(true);
    expect(out.results[0].content).toContain("세션 한도 초과");
  });
});

/**
 * Direct scoring-guard tests — exercising `scoreCatalogEntry` via its
 * test-only export so the MIN_CATALOG_MATCH_TOKEN_LENGTH guards inside the
 * function are covered independently of the tokenizeQuery pre-filter.
 * (The handleToolSearch tests above exercise the tokenizer path; these pin
 * the scoring boundary itself, so deleting either guard fails a test.)
 */
describe("_scoreCatalogEntryForTest — scoring-boundary MIN_CATALOG_MATCH_TOKEN_LENGTH guard", () => {
  const entry = { name: "meeting_start", description: "begin a recorded meeting" };

  it("gives zero score to a token below the minimum length", () => {
    // Passing a raw sub-min token directly to the scorer, bypassing tokenizeQuery.
    // The guard on line 105 of tool-search.ts must catch it; without the guard
    // "a" would score 30 via description.includes("a") on 'begin a recorded meeting'.
    const score = _scoreCatalogEntryForTest("a", ["a"], entry);
    expect(score).toBe(0);
  });

  it("scores a token of exactly the minimum length normally", () => {
    // A 2-char token exactly at the threshold must still contribute score.
    // "me" is a prefix of "meeting_start" → name.startsWith → +350.
    const score = _scoreCatalogEntryForTest("me", ["me"], entry);
    expect(score).toBeGreaterThan(0);
  });

  it("ignores sub-min tokens in a mixed array but scores valid tokens", () => {
    // ["a", "meeting"] — "a" must contribute nothing; "meeting" (nameToken match)
    // must contribute +300.  This directly pins both guards (lines 100 and 105).
    const score = _scoreCatalogEntryForTest("a meeting", ["a", "meeting"], entry);
    // Only "meeting" contributes: name.startsWith("meeting") → 350
    // plus description.includes("meeting") → 30.
    expect(score).toBe(380);
  });

  it("gives zero score when the whole query is below the minimum length", () => {
    // The exact-match guard (query.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH) on
    // line 100 must prevent a 1-char query from scoring 1000 on a 1-char name.
    const tiny = { name: "m", description: "shorthand tool" };
    const score = _scoreCatalogEntryForTest("m", ["m"], tiny);
    expect(score).toBe(0);
  });
});

describe("computeIdfWeights — IDF ranking", () => {
  const entry = (name: string, description: string) => ({ name, description });

  it("damps a catalog-common token below a rare token", () => {
    const catalog = [
      entry("list_users", "list the users"),
      entry("list_files", "list the files"),
      entry("list_repos", "list the repos"),
      entry("reconcile_ledger", "reconcile the ledger"),
    ];
    const weights = _computeIdfWeightsForTest(catalog, ["list", "reconcile"]);
    expect(weights.get("list")!).toBeLessThan(weights.get("reconcile")!);
    expect(weights.get("list")!).toBeLessThan(0.7); // common (3/4) → damped
    expect(weights.get("reconcile")!).toBeGreaterThan(0.9); // rare (1/4) → ~1.0
  });

  it("clamps a near-ubiquitous token to the 0.2 floor in a large catalog", () => {
    const catalog = Array.from({ length: 30 }, (_, i) => entry(`get_thing_${i}`, "get a thing"));
    const weights = _computeIdfWeightsForTest(catalog, ["get"]);
    expect(weights.get("get")!).toBeCloseTo(0.2, 1);
  });

  it("ranks a rare-token match above a common-token match of the same tier", () => {
    const catalog = [
      entry("list_a", "list a"),
      entry("list_b", "list b"),
      entry("list_c", "list c"),
      entry("reconcile_x", "reconcile x"),
    ];
    const weights = _computeIdfWeightsForTest(catalog, ["list", "reconcile"]);
    // Both are whole-name-token matches (tier 700); IDF breaks the tie.
    const listScore = _scoreCatalogEntryForTest("list", ["list"], entry("list_a", "list a"), weights);
    const rareScore = _scoreCatalogEntryForTest("reconcile", ["reconcile"], entry("reconcile_x", "reconcile x"), weights);
    expect(rareScore).toBeGreaterThan(listScore);
  });

  it("defaults to weight 1 when no IDF map is supplied (pre-IDF behavior preserved)", () => {
    const e = entry("query_tool", "run a query");
    expect(_scoreCatalogEntryForTest("query", ["query"], e)).toBe(
      _scoreCatalogEntryForTest("query", ["query"], e, new Map([["query", 1]])),
    );
  });

  it("returns an empty map for an empty catalog", () => {
    expect(_computeIdfWeightsForTest([], ["x"]).size).toBe(0);
  });
});
