/**
 * Knowledge Search Tool — LLM agentic 검색 루프
 *
 * 청사진 §1 C1: Phase 1에서 검색 주체는 LVIS agentic 루프.
 *   Local indexer는 데이터 소스일 뿐 `search()`가 없음.
 *   → LVIS가 OpenAI function calling 4개 도구를 노출하여 LLM이 직접 트리를 탐색.
 *
 * 청사진 §6.1: `lvis-app/src/tools/knowledge-search.ts`
 * 청사진 §10 S5: LLM Agentic 검색 시나리오
 * 청사진 §11 리스크: LLM agentic 토큰 폭발 → top-5 + depth ≤3 하드 캡
 *
 * 4 tools를 ToolRegistry에 등록:
 *   1. knowledge_search(query, topK?)        — HybridRetriever 호출, top 결과 반환
 *   2. document_list()                        — 인덱싱된 문서 목록
 *   3. document_structure(docId)              — local index tree (agentic)
 *   4. document_page_content(docId, pages)    — 특정 페이지 내용 (agentic)
 *
 * LLM은 knowledge_search로 후보 chunk를 받고, document_structure /
 * document_page_content를 function calling으로 호출하여 트리를 탐색하며
 * 정확한 페이지를 찾음 (depth ≤ 3 hard cap — 청사진 §11).
 *
 * Depth 카운팅은 ConversationLoop의 tool_call 카운터에 위임 (이 파일 외부 책임).
 * 본 모듈은 도구 정의만 제공한다.
 *
 * 각 도구는 {@link createDynamicTool}로 생성되어 {@link Tool} 계약을
 * 만족한다. 도구별 execute()는 `ToolResult { output, isError, metadata? }`
 * 형태를 반환하며, 결과는 JSON 문자열로 직렬화되어 LLM에 전달된다.
 */

import { createDynamicTool, type Tool } from "./base.js";
import type { HybridRetriever, HybridResult } from "../main/hybrid-retriever.js";

// ─── 외부 의존 인터페이스 (Agent 4가 구현) ─────────

/**
 * knowledge-search-tool이 요구하는 문서 메타 조회 클라이언트.
 * Local Indexer worker client가 이 shape을
 * 만족해야 한다 (16 엔드포인트 중 /documents, /structure, /page-content).
 */
export interface KnowledgeWorkerClient {
  /** GET /documents — 인덱싱된 모든 문서 메타 */
  listDocuments(): Promise<
    Array<{
      docId: string;
      docName: string;
      /** "pdf" | "docx" | "pptx" | "xlsx" | "md" 등 */
      type: string;
      /** 선택적 추가 메타 */
      pageCount?: number;
      updatedAt?: string;
    }>
  >;

  /** GET /structure — local index tree structure */
  getStructure(docId: string): Promise<unknown>;

  /**
   * GET /page-content — 특정 페이지 범위의 본문.
   * pages는 local indexer 관행에 따라 "5" / "5-7" / "1,3,5-7" 같은 표현식.
   */
  getPageContent(
    docId: string,
    pages: string,
  ): Promise<Array<{ page: number; content: string }>>;
}

export interface KnowledgeSearchToolDeps {
  hybridRetriever: HybridRetriever;
  workerClient: KnowledgeWorkerClient;
  /** knowledge_search 기본 topK (기본 5, 청사진 §11 하드 캡 준수) */
  defaultTopK?: number;
  /** knowledge_search 최대 topK (기본 10) */
  maxTopK?: number;
  /** snippet 자르기 길이 (기본 200자) */
  snippetMaxChars?: number;
}

// ─── knowledge_search 반환 shape ───────────────────

/**
 * LLM에 JSON으로 주입될 단일 검색 결과.
 * rawText 전체 대신 snippet(≤200자)만 보냄 → 토큰 절약.
 * 상세가 필요하면 LLM이 document_page_content를 후속 호출.
 */
export interface KnowledgeSearchResultItem {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  snippet: string;
  score: number;
  sources: Array<"bm25" | "vec" | "cloud">;
}

// ─── 팩토리 ──────────────────────────────────────────

/**
 * 4개 LLM tool 정의를 생성하여 반환.
 * ToolRegistry.register 로 등록해야 LLM이 function calling 가능.
 */
export function createKnowledgeSearchTools(
  deps: KnowledgeSearchToolDeps,
): Tool[] {
  const defaultTopK = deps.defaultTopK ?? 5;
  const maxTopK = deps.maxTopK ?? 10;
  const snippetMaxChars = deps.snippetMaxChars ?? 200;

  const knowledgeSearchTool = createDynamicTool({
    name: "knowledge_search",
    description:
      "사용자 질문과 관련된 사내 문서 chunk를 검색합니다. BM25 + 벡터 hybrid retrieval (RRF k=60) 기반으로 최대 10개 결과를 반환합니다. 결과의 chunk_id, doc_id, page, snippet을 활용하여 추가 상세가 필요하면 document_structure와 document_page_content를 호출하세요. 가장 먼저 호출해야 하는 1차 검색 도구입니다.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "검색 질의 (한국어 가능, 사용자 질문을 그대로 전달해도 됨)",
        },
        topK: {
          type: "integer",
          description: `반환할 결과 개수 (기본 ${defaultTopK}, 최대 ${maxTopK})`,
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
    description:
      "인덱싱된 모든 문서의 목록(docId, docName, type)을 반환합니다. 특정 문서를 지칭해서 탐색하고 싶을 때 사용하세요.",
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
    description:
      "특정 문서의 로컬 인덱스 트리 구조를 반환합니다. 트리의 노드 제목을 보고 관련 페이지 범위를 추론한 다음, document_page_content로 그 범위를 읽으세요. 이는 agentic 루프의 2-hop 탐색에 사용됩니다.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        docId: {
          type: "string",
          description: "knowledge_search 또는 document_list에서 받은 doc_id",
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
    description:
      "특정 문서의 페이지 범위 내용을 반환합니다. pages 파라미터는 local indexer 표현식으로, '5' (단일 페이지), '5-7' (범위), '1,3,5-7' (복합)의 세 형식을 지원합니다. knowledge_search의 결과 또는 document_structure의 노드를 본 뒤 정확한 페이지 본문을 얻기 위해 호출하세요.",
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
          description: "페이지 표현식 (예: '5', '5-7', '1,3,5-7')",
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

// ─── 유틸 ────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}
