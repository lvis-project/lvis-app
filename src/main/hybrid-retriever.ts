




import type { CloudIndexAdapter, CloudIndexHit } from "./cloud-index-adapter.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("hybrid-retriever");






export interface SearchHit {

  source: "bm25" | "vec" | "cloud";

  chunkId: string;

  docId: string;

  docName: string;

  page?: number;

  rawText: string;

  rank: number;

  score: number;
}




export interface HybridResult {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  rawText: string;

  rrfScore: number;



  sources: Array<{ source: "bm25" | "vec" | "cloud"; rank: number; score: number }>;
}




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

  weights?: HybridRetrieverWeights;

  rrfK?: number;

  cloudTimeoutMs?: number;

  overfetchMultiplier?: number;
}



export const DEFAULT_HYBRID_WEIGHTS: HybridRetrieverWeights = {
  bm25: 0.5,
  vec: 0.5,
  cloud: 0.0,
};

export const DEFAULT_RRF_K = 60;
export const DEFAULT_CLOUD_TIMEOUT_MS = 1500;
export const DEFAULT_OVERFETCH_MULTIPLIER = 3;






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






  private addHits(
    aggregate: Map<string, HybridResult>,
    hits: SearchHit[],
    weight: number,
  ): void {
    if (weight <= 0) {


      return;
    }

    hits.forEach((hit, idx) => {

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
        chunkId: `cloud:${ch.docId}:${idx}`, // Cloud results may not be chunk-addressable, so synthesize an id.
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
