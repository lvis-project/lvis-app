/**
 * search_memory — BM25-lite ranking correctness.
 */
import { describe, it, expect } from "vitest";
import {
  rankNotes,
  scoreNotes,
  tokenize,
  createSearchMemoryTool,
  memoryManagerNotesAdapter,
  type SearchMemoryNote,
} from "../search-memory.js";

const fixture: SearchMemoryNote[] = [
  {
    title: "팀 회고 정리",
    content: "스프린트 E 회고. 검색 기능 개선, PII 리댁트 도입.",
    updatedAt: "2026-04-10T00:00:00Z",
  },
  {
    title: "주말 여행 계획",
    content: "강원도 속초 1박 2일. 설악산 케이블카 예약 필요.",
    updatedAt: "2026-04-11T00:00:00Z",
  },
  {
    title: "검색 아키텍처 메모",
    content: "BM25 hybrid retrieval, RRF k=60, 벡터 검색 결합.",
    updatedAt: "2026-04-12T00:00:00Z",
  },
  {
    title: "빈 메모",
    content: "",
  },
];

describe("tokenize", () => {
  it("splits on non-word chars and drops short tokens", () => {
    expect(tokenize("검색 BM25 a bb ccc")).toEqual(["검색", "bm25", "bb", "ccc"]);
  });
});

describe("scoreNotes", () => {
  it("returns zero scores when query has no meaningful tokens", () => {
    const scores = scoreNotes("", fixture);
    expect(scores).toEqual([0, 0, 0, 0]);
  });

  it("gives higher score to the note matching query terms in both title and content", () => {
    const scores = scoreNotes("검색 BM25", fixture);
    // note[2] — title + content hit — should outscore note[0] (content hit only)
    expect(scores[2]).toBeGreaterThan(scores[0]);
    expect(scores[1]).toBe(0);
    expect(scores[3]).toBe(0);
  });

  it("title terms outweigh content-only terms (title weight 2x)", () => {
    const corpus: SearchMemoryNote[] = [
      { title: "foo bar", content: "unrelated body" },
      { title: "unrelated", content: "foo bar occurs once here" },
    ];
    const scores = scoreNotes("foo bar", corpus);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
});

describe("rankNotes", () => {
  it("returns top-K results sorted by score, truncates snippet, drops zero-score", () => {
    const results = rankNotes("검색 BM25", fixture, 5, 40);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("검색 아키텍처 메모");
    // sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    // snippet truncated
    for (const r of results) expect(r.snippet.length).toBeLessThanOrEqual(43); // 40 + "..."
    // zero-score notes excluded
    expect(results.every((r) => r.score > 0)).toBe(true);
    expect(results.find((r) => r.title === "주말 여행 계획")).toBeUndefined();
  });

  it("honours topK cap", () => {
    const results = rankNotes("검색", fixture, 1, 200);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe("createSearchMemoryTool", () => {
  it("returns a Tool with name=search_memory, source=builtin, read-only", () => {
    const tool = createSearchMemoryTool({ getNotes: () => fixture });
    expect(tool.name).toBe("search_memory");
    expect(tool.source).toBe("builtin");
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly({})).toBe(true);
  });

  it("execute returns JSON string of ranked results", async () => {
    const tool = createSearchMemoryTool({ getNotes: () => fixture });
    const res = await tool.execute({ query: "BM25 검색", topK: 3 }, {
      cwd: "/tmp",
      extraAllowedDirectories: [],
      metadata: {},
    } as never);
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.output as string) as Array<{ title: string; score: number }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].title).toBe("검색 아키텍처 메모");
  });

  it("empty query returns empty array without error", async () => {
    const tool = createSearchMemoryTool({ getNotes: () => fixture });
    const res = await tool.execute({ query: "  " }, { cwd: "/tmp", extraAllowedDirectories: [], metadata: {} } as never);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.output as string)).toEqual([]);
  });

  it("catches provider errors and returns isError=true", async () => {
    const tool = createSearchMemoryTool({
      getNotes: () => {
        throw new Error("boom");
      },
    });
    const res = await tool.execute({ query: "x" }, { cwd: "/tmp", extraAllowedDirectories: [], metadata: {} } as never);
    expect(res.isError).toBe(true);
  });
});

describe("memoryManagerNotesAdapter", () => {
  it("preserves updatedAt from memory entries", () => {
    const getNotes = memoryManagerNotesAdapter({
      listMemoryEntries: () => [
        {
          filename: "m1.md",
          title: "메모",
          content: "# 메모\n\n본문",
          updatedAt: "2026-04-20T00:00:00Z",
        },
      ],
    } as unknown as import("../../memory/memory-manager.js").MemoryManager);

    expect(getNotes()).toEqual([
      {
        title: "메모",
        content: "# 메모\n\n본문",
        updatedAt: "2026-04-20T00:00:00Z",
      },
    ]);
  });
});
