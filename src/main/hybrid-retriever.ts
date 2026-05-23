/**
 * HybridRetriever — Local Indexer (BM25 + Vector) + Cloud 결합
 *
 * 청사진 §1 C4: RRF k=60, weights {bm25:0.5, vec:0.5, cloud:0.0}
 * 청사진 §6.1: `lvis-app/src/main/hybrid-retriever.ts`
 * 청사진 §8 컴포넌트 다이어그램: HybridRetriever → workerClient.searchBm25/Vector + CloudAdapter
 *
 * LightRAG 추가 시 weights 재정규화:
 *   {bm25:0.35, vec:0.35, lightrag:0.3} 또는
 *   {bm25:0.35, vec:0.35, cloud:0.3}
 *
 * RRF (Reciprocal Rank Fusion) 공식:
 *   score(d) = Σ_r weight_r * (1 / (k + rank_r + 1))
 *
 * `+1`은 0-based rank 보정 (최상위 문서가 rank=0일 때 분모가 k+1이 되도록).
 *
 * INTEGRATION NOTE for Agent 4 (Plugin Integrator):
 * boot.ts bootstrap()에서:
 *   import { HybridRetriever } from "./main/hybrid-retriever.js";
 *   import { MockCloudIndexAdapter } from "./main/cloud-index-adapter.js";
 *
 *   const cloudAdapter = new MockCloudIndexAdapter();
 *   const workerClient = localIndexerPlugin.getWorkerClient();  // Agent 4가 추가
 *   const hybridRetriever = new HybridRetriever({
 *     workerClient,
 *     cloudAdapter,
 *   });
 *
 *   // 그 다음 registerBuiltinTools() 확장 영역에서 knowledge-search-tool.ts의
 *   // createKnowledgeSearchTools({ hybridRetriever, workerClient, ... })를 등록
 */

import type { CloudIndexAdapter, CloudIndexHit } from "./cloud-index-adapter.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("hybrid-retriever");

// ─── 타입 ────────────────────────────────────────────

/**
 * 단일 retriever (BM25 또는 Vector)가 반환하는 개별 hit.
 *
 * Agent 2의 Python worker (/search/bm25, /search/vector)가
 * 이 shape 배열을 HTTP로 반환하며, Agent 4의 workerClient.ts가
 * 파싱 후 타입을 강제한다.
 */
export interface SearchHit {
  /** 이 hit을 생산한 retriever 종류 */
  source: "bm25" | "vec" | "cloud";
  /** 전역 유일 chunk ID (worker의 chunks 테이블 primary key) */
  chunkId: string;
  /** 이 chunk가 속한 문서 ID */
  docId: string;
  /** 사용자 표시용 문서명 (파일명 또는 메타 title) */
  docName: string;
  /** 페이지 번호 (없을 수 있음 — 예: 마크다운) */
  page?: number;
  /** chunk 원문 텍스트 (LLM 프롬프트에 주입될 소재) */
  rawText: string;
  /** 원래 retriever의 0-based rank (0 = 최상위) */
  rank: number;
  /** 원래 retriever의 원점수 (BM25: MATCH score, Vector: cosine similarity) */
  score: number;
}

/**
 * RRF 합산 후 최종 hybrid 결과.
 * LLM에 전달될 때는 rawText + docName + page 만 사용되지만,
 * 디버깅/UI 표시를 위해 sources 배열과 rrfScore도 보존한다.
 */
export interface HybridResult {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  rawText: string;
  /** RRF 최종 score — 이 값 기준 내림차순 정렬 */
  rrfScore: number;
  /**
   * 이 chunk에 기여한 retriever 출처 목록.
   * 한 chunk가 여러 retriever에서 hit된 경우 2개 이상.
   */
  sources: Array<{ source: "bm25" | "vec" | "cloud"; rank: number; score: number }>;
}

/**
 * Agent 2의 Python worker HTTP API를 감싸는 TS 클라이언트 인터페이스.
 * Document-indexer plugin worker client가 worker 엔드포인트 중
 * /search/bm25, /search/vector 두 개를 이 shape로 노출한다.
 *
 * HybridRetriever는 이 인터페이스에만 의존 — 실클라이언트/Mock 모두 주입 가능.
 */
export interface WorkerSearchClient {
  searchBm25(query: string, topK: number): Promise<SearchHit[]>;
  searchVector(query: string, topK: number): Promise<SearchHit[]>;
}

export interface HybridRetrieverWeights {
  bm25: number;
  vec: number;
  cloud: number;
}

export interface HybridRetrieverOptions {
  workerClient: WorkerSearchClient;
  cloudAdapter: CloudIndexAdapter;
  /** 청사진 §1 C4 기본값 {bm25:0.5, vec:0.5, cloud:0.0} */
  weights?: HybridRetrieverWeights;
  /** RRF k 상수. 청사진 기본값 60 */
  rrfK?: number;
  /** CloudIndexAdapter.search() 타임아웃(ms). 기본 1500 */
  cloudTimeoutMs?: number;
  /** 각 retriever에 요청할 과샘플링 배수. topK * overfetch 만큼 요청하여 RRF 합산 정확도 향상 */
  overfetchMultiplier?: number;
}

// ─── 기본값 ──────────────────────────────────────────

export const DEFAULT_HYBRID_WEIGHTS: HybridRetrieverWeights = {
  bm25: 0.5,
  vec: 0.5,
  cloud: 0.0,
};

export const DEFAULT_RRF_K = 60;
export const DEFAULT_CLOUD_TIMEOUT_MS = 1500;
export const DEFAULT_OVERFETCH_MULTIPLIER = 3;

// ─── 구현 ────────────────────────────────────────────

/**
 * HybridRetriever.
 *
 * 호출 흐름:
 *   1. Promise.all로 bm25 / vector / cloud 세 검색을 병렬 실행
 *   2. cloud는 타임아웃 걸어 race (타임아웃 시 빈 배열로 처리)
 *   3. 각 결과를 chunkId 기준으로 RRF 합산 (중복 chunk 통합)
 *   4. rrfScore 내림차순 정렬 후 상위 topK 반환
 */
export class HybridRetriever {
  private readonly workerClient: WorkerSearchClient;
  private readonly cloudAdapter: CloudIndexAdapter;
  private readonly weights: HybridRetrieverWeights;
  private readonly rrfK: number;
  private readonly cloudTimeoutMs: number;
  private readonly overfetchMultiplier: number;

  constructor(options: HybridRetrieverOptions) {
    this.workerClient = options.workerClient;
    this.cloudAdapter = options.cloudAdapter;
    this.weights = options.weights ?? DEFAULT_HYBRID_WEIGHTS;
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    this.cloudTimeoutMs = options.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
    this.overfetchMultiplier = options.overfetchMultiplier ?? DEFAULT_OVERFETCH_MULTIPLIER;
  }

  /**
   * 질의어로 hybrid 검색 실행.
   *
   * @param query 사용자 질의 (한국어 가능 — Python worker가 kiwi 토큰화 수행)
   * @param topK 최종 반환 결과 수 (1 이상 권장)
   * @returns RRF score 내림차순으로 정렬된 HybridResult[]
   */
  async retrieve(query: string, topK: number): Promise<HybridResult[]> {
    if (topK <= 0) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const perSource = Math.max(topK, topK * this.overfetchMultiplier);

    const [bm25Hits, vecHits, cloudHits] = await Promise.all([
      this.safeBm25(trimmed, perSource),
      this.safeVector(trimmed, perSource),
      this.safeCloud(trimmed, perSource),
    ]);

    const aggregate = new Map<string, HybridResult>();
    this.addHits(aggregate, bm25Hits, this.weights.bm25);
    this.addHits(aggregate, vecHits, this.weights.vec);
    this.addHits(aggregate, cloudHits, this.weights.cloud);

    return [...aggregate.values()]
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK);
  }

  // ─── RRF 합산 ────────────────────────────────────

  /**
   * RRF 합산 로직. 청사진 §1 C4 수식:
   *   contribution = weight * (1 / (k + rank + 1))
   * +1은 0-based rank 보정.
   *
   * 같은 chunkId가 여러 retriever에서 hit되면 contribution을 누적한다.
   */
  private addHits(
    aggregate: Map<string, HybridResult>,
    hits: SearchHit[],
    weight: number,
  ): void {
    if (weight <= 0) {
      // weight 0이더라도 sources 기록용으로 남길지 여부:
      // 청사진은 빈 cloud를 "degenerate"로 취급하므로 기여를 생략.
      return;
    }

    hits.forEach((hit, idx) => {
      // hit.rank가 제공되면 그대로, 아니면 배열 순서를 rank로 사용.
      const rank = Number.isFinite(hit.rank) ? hit.rank : idx;
      const contribution = weight * (1 / (this.rrfK + rank + 1));

      const existing = aggregate.get(hit.chunkId);
      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.push({ source: hit.source, rank, score: hit.score });
      } else {
        aggregate.set(hit.chunkId, {
          chunkId: hit.chunkId,
          docId: hit.docId,
          docName: hit.docName,
          page: hit.page,
          rawText: hit.rawText,
          rrfScore: contribution,
          sources: [{ source: hit.source, rank, score: hit.score }],
        });
      }
    });
  }

  // ─── 개별 retriever 호출 (안전 래퍼) ──────────────

  private async safeBm25(query: string, topK: number): Promise<SearchHit[]> {
    try {
      const hits = await this.workerClient.searchBm25(query, topK);
      return this.normalizeHits(hits, "bm25");
    } catch (err) {
      log.warn("bm25 search failed: %s", (err as Error).message);
      return [];
    }
  }

  private async safeVector(query: string, topK: number): Promise<SearchHit[]> {
    try {
      const hits = await this.workerClient.searchVector(query, topK);
      return this.normalizeHits(hits, "vec");
    } catch (err) {
      log.warn("vector search failed: %s", (err as Error).message);
      return [];
    }
  }

  private async safeCloud(query: string, topK: number): Promise<SearchHit[]> {
    // weight 0이면 호출 자체를 생략.
    if (this.weights.cloud <= 0) return [];

    try {
      const timeoutPromise = new Promise<CloudIndexHit[]>((_, reject) => {
        setTimeout(
          () => reject(new Error(`cloud search timeout after ${this.cloudTimeoutMs}ms`)),
          this.cloudTimeoutMs,
        );
      });
      const cloudHits = await Promise.race([
        this.cloudAdapter.search(query, topK),
        timeoutPromise,
      ]);
      return cloudHits.map((ch, idx) => ({
        source: "cloud" as const,
        chunkId: `cloud:${ch.docId}:${idx}`, // cloud는 chunk 단위가 아닐 수 있음 → 의사 id
        docId: ch.docId,
        docName: ch.docName,
        rawText: ch.snippet,
        rank: idx,
        score: ch.score,
      }));
    } catch (err) {
      log.warn("cloud search failed: %s", (err as Error).message);
      return [];
    }
  }

  /**
   * worker가 반환한 hits에 source/rank가 누락된 경우를 대비한 정규화.
   * rank가 없으면 배열 순서로 부여.
   */
  private normalizeHits(hits: SearchHit[], source: "bm25" | "vec"): SearchHit[] {
    return hits.map((hit, idx) => ({
      ...hit,
      source,
      rank: Number.isFinite(hit.rank) ? hit.rank : idx,
    }));
  }
}
