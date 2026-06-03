// AUTO-GENERATED — i18n migration. Source: src/tools/knowledge-search.ts. Do not edit by hand.
export const en = {
  "be_knowledgeSearch.knowledgeSearchDescription":
    "Search document chunks relevant to the user's question. Uses BM25 + vector hybrid retrieval (RRF k=60), returning up to 10 results. Use chunk_id, doc_id, page, and snippet from results; call document_structure or document_page_content for further detail. This is the primary search tool and should be called first.",
  "be_knowledgeSearch.queryDescription":
    "Search query (natural language; you may pass the user's question verbatim).",
  "be_knowledgeSearch.topKDescription":
    "Number of results to return (default {defaultTopK}, max {maxTopK}).",
  "be_knowledgeSearch.documentListDescription":
    "Returns a list (docId, docName, type) of all indexed documents. Use this when you want to browse or reference a specific document.",
  "be_knowledgeSearch.documentStructureDescription":
    "Returns the local index tree structure of a specific document. Inspect the node titles to infer relevant page ranges, then call document_page_content to read those pages. Used for 2-hop navigation in the agentic loop.",
  "be_knowledgeSearch.docIdDescription":
    "The doc_id received from knowledge_search or document_list.",
  "be_knowledgeSearch.documentPageContentDescription":
    "Returns the content of a page range from a specific document. The pages parameter uses local indexer expressions: '5' (single page), '5-7' (range), '1,3,5-7' (composite). Call this after reviewing knowledge_search results or document_structure nodes to retrieve the exact page content.",
  "be_knowledgeSearch.pagesDescription":
    "Page expression (e.g. '5', '5-7', '1,3,5-7').",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_knowledgeSearch.knowledgeSearchDescription":
    "사용자 질문과 관련된 문서 chunk를 검색합니다. BM25 + 벡터 hybrid retrieval (RRF k=60) 기반으로 최대 10개 결과를 반환합니다. 결과의 chunk_id, doc_id, page, snippet을 활용하여 추가 상세가 필요하면 document_structure와 document_page_content를 호출하세요. 가장 먼저 호출해야 하는 1차 검색 도구입니다.",
  "be_knowledgeSearch.queryDescription":
    "검색 질의 (한국어 가능, 사용자 질문을 그대로 전달해도 됨)",
  "be_knowledgeSearch.topKDescription":
    "반환할 결과 개수 (기본 {defaultTopK}, 최대 {maxTopK})",
  "be_knowledgeSearch.documentListDescription":
    "인덱싱된 모든 문서의 목록(docId, docName, type)을 반환합니다. 특정 문서를 지칭해서 탐색하고 싶을 때 사용하세요.",
  "be_knowledgeSearch.documentStructureDescription":
    "특정 문서의 로컬 인덱스 트리 구조를 반환합니다. 트리의 노드 제목을 보고 관련 페이지 범위를 추론한 다음, document_page_content로 그 범위를 읽으세요. 이는 agentic 루프의 2-hop 탐색에 사용됩니다.",
  "be_knowledgeSearch.docIdDescription":
    "knowledge_search 또는 document_list에서 받은 doc_id",
  "be_knowledgeSearch.documentPageContentDescription":
    "특정 문서의 페이지 범위 내용을 반환합니다. pages 파라미터는 local indexer 표현식으로, '5' (단일 페이지), '5-7' (범위), '1,3,5-7' (복합)의 세 형식을 지원합니다. knowledge_search의 결과 또는 document_structure의 노드를 본 뒤 정확한 페이지 본문을 얻기 위해 호출하세요.",
  "be_knowledgeSearch.pagesDescription":
    "페이지 표현식 (예: '5', '5-7', '1,3,5-7')",
};
