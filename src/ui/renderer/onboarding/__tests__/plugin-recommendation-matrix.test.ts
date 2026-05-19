import { describe, expect, it } from "vitest";
import { inferRecommendedPlugins } from "../plugin-recommendation-matrix.js";

describe("inferRecommendedPlugins", () => {
  it("returns the chat-basics fallback for empty input", () => {
    expect(inferRecommendedPlugins("")).toEqual([
      { pluginId: "chat-basics", label: "chat 기본 사용", emoji: "💬", marketplaceSlug: null },
    ]);
    expect(inferRecommendedPlugins("   \n\t")).toEqual([
      { pluginId: "chat-basics", label: "chat 기본 사용", emoji: "💬", marketplaceSlug: null },
    ]);
  });

  it("maps Korean meeting keywords to the meeting plugin", () => {
    const ids = inferRecommendedPlugins("매주 회의가 많은 PM").map((r) => r.pluginId);
    expect(ids).toContain("meeting");
    expect(ids).not.toContain("chat-basics");
  });

  it("hits multiple plugin rows in narrative order", () => {
    const ids = inferRecommendedPlugins(
      "회의록 정리하고 문서 검색도 자주 합니다. 일정 관리 자동화",
    ).map((r) => r.pluginId);
    // Matrix order: meeting → local-indexer → work-proactive → ms-graph → agent-hub
    // "일정" hits both work-proactive and ms-graph rows (shared keyword by design —
    // scheduling spans both surfaces).
    expect(ids).toEqual(["meeting", "local-indexer", "work-proactive", "ms-graph"]);
  });

  it("collapses duplicate hits from synonyms", () => {
    const ids = inferRecommendedPlugins("회의 미팅 녹음 stt").map((r) => r.pluginId);
    expect(ids).toEqual(["meeting"]);
  });

  it("is case-insensitive for English keywords", () => {
    const ids = inferRecommendedPlugins("Agent orchestration").map((r) => r.pluginId);
    expect(ids).toContain("agent-hub");
  });
});
