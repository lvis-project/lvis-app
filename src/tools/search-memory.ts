/**
 * search_memory — Sprint E agentic memory search tool.
 *
 * LLM이 과거 memory/에서 현재 질의와 관련된 메모를 찾을 수 있도록 노출되는
 * builtin 도구. MemoryManager.listMemoryEntries() 의 (title, content, updatedAt)
 * 를 BM25-lite 로 스코어링하여 top-K 결과를 반환한다.
 *
 * 반환 shape: [{ title, snippet (≤200자), updatedAt, score }]
 *
 * 구현 메모:
 * - BM25 lite: term freq × idf × length-normalize (k1=1.2, b=0.75)
 * - title 은 content 보다 2x 가중
 * - 한국어 분절은 단순 whitespace + 비단어 분리 (kiwi 등 미사용, Phase1 단순성)
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { MemoryManager } from "../memory/memory-manager.js";

export interface SearchMemoryNote {
  title: string;
  content: string;
  updatedAt?: string;
}

export interface SearchMemoryResult {
  title: string;
  snippet: string;
  updatedAt?: string;
  score: number;
}

export interface SearchMemoryDeps {
  /**
   * Memory 소스 provider. 테스트 시 fixture를, 프로덕션에서는
   * MemoryManager.listMemoryEntries() 어댑터를 전달한다.
   */
  getNotes: () => SearchMemoryNote[];
  defaultTopK?: number;
  maxTopK?: number;
  snippetMaxChars?: number;
}

const TITLE_WEIGHT = 2;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 간단한 한영 혼용 토크나이저 — 2자 이상 토큰만 유지. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * BM25-lite 스코어링.
 * - title 토큰은 content 토큰에 2배 weight로 합산 (단일 doc 간주)
 * - idf = ln((N - df + 0.5) / (df + 0.5) + 1)
 */
export function scoreNotes(
  query: string,
  notes: SearchMemoryNote[],
): number[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || notes.length === 0) {
    return notes.map(() => 0);
  }

  const titleTokens: string[][] = notes.map((n) => tokenize(n.title));
  const contentTokens: string[][] = notes.map((n) => tokenize(n.content));
  const docTokens: string[][] = notes.map((_, i) => [
    ...titleTokens[i],
    ...contentTokens[i],
  ]);
  const docLens = docTokens.map((t) => t.length);
  const avgDl =
    docLens.reduce((a, b) => a + b, 0) / Math.max(1, docLens.length);

  const N = notes.length;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const idf = (term: string): number => {
    const freq = df.get(term) ?? 0;
    return Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
  };

  const scores = docTokens.map((tokens, i) => {
    const dl = docLens[i] || 1;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const titleSet = new Set(titleTokens[i]);
    let s = 0;
    for (const q of queryTokens) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const num = f * (BM25_K1 + 1);
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
      const base = idf(q) * (num / denom);
      // title 토큰에 매칭되면 TITLE_WEIGHT 배 가중.
      s += titleSet.has(q) ? base * TITLE_WEIGHT : base;
    }
    return s;
  });

  return scores;
}

export function rankNotes(
  query: string,
  notes: SearchMemoryNote[],
  topK: number,
  snippetMaxChars: number,
): SearchMemoryResult[] {
  const scores = scoreNotes(query, notes);
  const ranked = notes
    .map((note, i) => ({ note, score: scores[i] ?? 0 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return ranked.map(({ note, score }) => ({
    title: note.title,
    snippet: truncate(note.content, snippetMaxChars),
    updatedAt: note.updatedAt,
    score,
  }));
}

function truncate(text: string, maxChars: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  if (maxChars <= 3) return flat.slice(0, maxChars);
  return flat.slice(0, maxChars - 3) + "...";
}

/**
 * search_memory 도구 팩토리. Boot 에서 MemoryManager 어댑터와 함께 등록.
 */
export function createSearchMemoryTool(deps: SearchMemoryDeps): Tool {
  const defaultTopK = deps.defaultTopK ?? 5;
  const maxTopK = deps.maxTopK ?? 20;
  const snippetMaxChars = deps.snippetMaxChars ?? 200;

  return createDynamicTool({
    name: "search_memory",
    description:
      "과거 사용자 메모(memory/)에서 현재 질의와 관련된 항목을 BM25-lite 로 검색합니다. " +
      "키 기반 단순 검색(memory_search) 대비 의미적 관련성을 랭킹에 반영합니다. " +
      "결과는 [{ title, snippet(≤200자), updatedAt, score }] 형식.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "검색 질의 (자연어, 한국어 가능)",
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
      const requested = Number(args.topK ?? defaultTopK);
      const topK = Math.min(
        maxTopK,
        Math.max(
          1,
          Number.isFinite(requested) ? Math.floor(requested) : defaultTopK,
        ),
      );
      try {
        const notes = deps.getNotes();
        const results = rankNotes(query, notes, topK, snippetMaxChars);
        return { output: JSON.stringify(results), isError: false };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: "search_memory failed",
            details: (err as Error).message,
          }),
          isError: true,
        };
      }
    },
  });
}

/**
 * MemoryManager → SearchMemoryNote 어댑터.
 */
export function memoryManagerNotesAdapter(
  memoryManager: MemoryManager,
): () => SearchMemoryNote[] {
  return () =>
    memoryManager.listMemoryEntries().map((n) => ({
      title: n.title,
      content: n.content,
      updatedAt: n.updatedAt,
    }));
}
