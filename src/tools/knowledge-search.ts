




import { createDynamicTool, type Tool } from "./base.js";
import type { HybridRetriever, HybridResult } from "../main/hybrid-retriever.js";
import { t } from "../i18n/index.js";






export interface KnowledgeWorkerClient {

  listDocuments(): Promise<
    Array<{
      docId: string;
      docName: string;

      type: string;

      pageCount?: number;
      updatedAt?: string;
    }>
  >;

  /** GET /structure — local index tree structure */
  getStructure(docId: string): Promise<unknown>;




  getPageContent(
    docId: string,
    pages: string,
  ): Promise<Array<{ page: number; content: string }>>;
}

export interface KnowledgeSearchToolDeps {
  hybridRetriever: HybridRetriever;
  workerClient: KnowledgeWorkerClient;

  defaultTopK?: number;

  maxTopK?: number;

  snippetMaxChars?: number;
}






export interface KnowledgeSearchResultItem {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  snippet: string;
  score: number;
  sources: Array<"bm25" | "vec" | "cloud">;
}






export function createKnowledgeSearchTools(
  deps: KnowledgeSearchToolDeps,
): Tool[] {
  const defaultTopK = deps.defaultTopK ?? 5;
  const maxTopK = deps.maxTopK ?? 10;
  const snippetMaxChars = deps.snippetMaxChars ?? 200;

  const knowledgeSearchTool = createDynamicTool({
    name: "knowledge_search",
    description: t("be_knowledgeSearch.knowledgeSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: t("be_knowledgeSearch.queryDescription"),
        },
        topK: {
          type: "integer",
          description: t("be_knowledgeSearch.topKDescription", { defaultTopK, maxTopK }),
        },
      },
      required: ["query"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { output: JSON.stringify([]), isError: false };
      }

      const requestedTopK = Number(args.topK ?? defaultTopK);
      const topK = Math.min(
        maxTopK,
        Math.max(
          1,
          Number.isFinite(requestedTopK) ? requestedTopK : defaultTopK,
        ),
      );

      try {
        const results = await deps.hybridRetriever.retrieve(query, topK);
        const mapped: KnowledgeSearchResultItem[] = results.map(
          (r: HybridResult) => ({
            chunkId: r.chunkId,
            docId: r.docId,
            docName: r.docName,
            page: r.page,
            snippet: truncate(r.rawText, snippetMaxChars),
            score: r.rrfScore,
            sources: r.sources.map((s) => s.source),
          }),
        );
        return { output: JSON.stringify(mapped), isError: false };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: "knowledge_search failed",
            details: (err as Error).message,
          }),
          isError: true,
        };
      }
    },
  });

  const documentListTool = createDynamicTool({
    name: "document_list",
    description: t("be_knowledgeSearch.documentListDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const docs = await deps.workerClient.listDocuments();
        return { output: JSON.stringify(docs), isError: false };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: "document_list failed",
            details: (err as Error).message,
          }),
          isError: true,
        };
      }
    },
  });

  const documentStructureTool = createDynamicTool({
    name: "document_structure",
    description: t("be_knowledgeSearch.documentStructureDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        docId: {
          type: "string",
          description: t("be_knowledgeSearch.docIdDescription"),
        },
      },
      required: ["docId"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const docId = String(args.docId ?? "").trim();
      if (!docId) {
        return {
          output: JSON.stringify({ error: "docId is required" }),
          isError: true,
        };
      }
      try {
        const structure = await deps.workerClient.getStructure(docId);
        return { output: JSON.stringify(structure), isError: false };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: "document_structure failed",
            details: (err as Error).message,
          }),
          isError: true,
        };
      }
    },
  });

  const documentPageContentTool = createDynamicTool({
    name: "document_page_content",
    description: t("be_knowledgeSearch.documentPageContentDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        docId: {
          type: "string",
          description: "doc_id",
        },
        pages: {
          type: "string",
          description: t("be_knowledgeSearch.pagesDescription"),
        },
      },
      required: ["docId", "pages"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const docId = String(args.docId ?? "").trim();
      const pages = String(args.pages ?? "").trim();
      if (!docId) {
        return {
          output: JSON.stringify({ error: "docId is required" }),
          isError: true,
        };
      }
      if (!pages) {
        return {
          output: JSON.stringify({ error: "pages is required" }),
          isError: true,
        };
      }
      try {
        const content = await deps.workerClient.getPageContent(docId, pages);
        return { output: JSON.stringify(content), isError: false };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: "document_page_content failed",
            details: (err as Error).message,
          }),
          isError: true,
        };
      }
    },
  });

  return [
    knowledgeSearchTool,
    documentListTool,
    documentStructureTool,
    documentPageContentTool,
  ];
}



function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}
