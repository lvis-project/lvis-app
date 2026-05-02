/**
 * Renderer Local Indexer capability-based tool lookup
 *
 * Verifies the logic that replaces the 3-name try-array:
 * find the plugin with "knowledge-index" capability, then find
 * its tool matching /list.*document/i.
 */

import { describe, it, expect } from "vitest";
import type { PluginCard } from "../runtime.js";

function findListDocumentTool(cards: PluginCard[]): string | undefined {
  const indexPlugin = cards.find((c) => c.capabilities.includes("knowledge-index"));
  const matchesListDocs = (name: string): boolean => {
    const n = name.toLowerCase();
    return /list.*document/.test(n) || /index.*document/.test(n);
  };
  return indexPlugin?.tools.find(matchesListDocs);
}

describe("renderer Local Indexer capability lookup", () => {
  it("finds tool from plugin with knowledge-index capability", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.email", name: "Email", description: "", sampleTools: [], tools: ["email_list"], capabilities: ["email-reader"] },
      { id: "local-indexer", name: "Local Indexer", description: "", sampleTools: [], tools: ["index_documents", "knowledge_search"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBe("index_documents");
  });

  it("returns undefined when no plugin has knowledge-index capability", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.email", name: "Email", description: "", sampleTools: [], tools: ["email_list"], capabilities: ["email-reader"] },
    ];
    expect(findListDocumentTool(cards)).toBeUndefined();
  });

  it("returns undefined when knowledge-index plugin has no matching tool", () => {
    const cards: PluginCard[] = [
      { id: "local-indexer", name: "Local Indexer", description: "", sampleTools: [], tools: ["knowledge_search"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBeUndefined();
  });

  it("matches local-indexer `index_documents` style (no 'list' verb)", () => {
    const cards: PluginCard[] = [
      { id: "local-indexer", name: "Local Indexer", description: "", sampleTools: [], tools: ["index_documents", "index_search"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBe("index_documents");
  });

  it("matches alternative tool name patterns", () => {
    const cards: PluginCard[] = [
      { id: "local-indexer", name: "Local Indexer", description: "", sampleTools: [], tools: ["list_documents"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBe("list_documents");
  });
});
