/**
 * Renderer PageIndex capability-based tool lookup
 *
 * Verifies the logic that replaces the 3-name try-array:
 * find the plugin with "knowledge-index" capability, then find
 * its tool matching /list.*document/i.
 */

import { describe, it, expect } from "vitest";
import type { PluginCard } from "../runtime.js";

function findListDocumentTool(cards: PluginCard[]): string | undefined {
  const indexPlugin = cards.find((c) => c.capabilities.includes("knowledge-index"));
  return indexPlugin?.tools.find((t) => /list.*document/i.test(t));
}

describe("renderer PageIndex capability lookup", () => {
  it("finds tool from plugin with knowledge-index capability", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.email", name: "Email", description: "", sampleTools: [], tools: ["email_list"], capabilities: ["email-reader"] },
      { id: "com.lge.pageindex", name: "PageIndex", description: "", sampleTools: [], tools: ["page_index_list_documents", "page_index_search"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBe("page_index_list_documents");
  });

  it("returns undefined when no plugin has knowledge-index capability", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.email", name: "Email", description: "", sampleTools: [], tools: ["email_list"], capabilities: ["email-reader"] },
    ];
    expect(findListDocumentTool(cards)).toBeUndefined();
  });

  it("returns undefined when knowledge-index plugin has no matching tool", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.pageindex", name: "PageIndex", description: "", sampleTools: [], tools: ["page_index_search"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBeUndefined();
  });

  it("matches alternative tool name patterns", () => {
    const cards: PluginCard[] = [
      { id: "com.lge.pageindex", name: "PageIndex", description: "", sampleTools: [], tools: ["pageindex_list_documents"], capabilities: ["knowledge-index"] },
    ];
    expect(findListDocumentTool(cards)).toBe("pageindex_list_documents");
  });
});
