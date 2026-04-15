/**
 * HybridRetriever — RRF 수학 검증 테스트
 *
 * 청사진 §1 C4: RRF k=60, weights {bm25:0.5, vec:0.5, cloud:0.0}
 * 청사진 §6.5: `lvis-app/src/main/__tests__/hybrid-retriever.test.ts`
 *
 * 실행: `cd lvis-app && npm test`
 *
 * SECURITY_GATE: 이 테스트 스위트는 RRF 수학의 정확도 회귀를 감지합니다.
 * 제거하려면 별도 RFC 필요.
 *
 * 검증 케이스:
 *   1) RRF 수학 정확성 — bm25 rank 0 + vec rank 0 동일 chunkId → ≈ 0.0164
 *   2) RRF 수학 정확성 — bm25 rank 0 + vec rank 4 동일 chunkId → ≈ 0.0159
 *   3) cloud Mock (weight 0) → 결합 결과에 cloud source 미포함
 *   4) 빈 결과 처리 — 모든 retriever 빈 배열 → []
 *   5) topK 잘림 정확
 *   6) 소스별 분리 — 서로 다른 chunkId는 독립 aggregate
 *   7) empty query returns []
 *   8) topK<=0 returns []
 *   9) worker bm25 failure → degrades to vec only
 */
import { describe, it, expect } from "vitest";
import {
  HybridRetriever,
  DEFAULT_RRF_K,
  type SearchHit,
  type WorkerSearchClient,
} from "../hybrid-retriever.js";
import { MockCloudIndexAdapter } from "../cloud-index-adapter.js";

// ─── Mock WorkerSearchClient ───────────────────────

class StubWorkerClient implements WorkerSearchClient {
  constructor(
    private readonly bm25Hits: SearchHit[] = [],
    private readonly vecHits: SearchHit[] = [],
  ) {}

  async searchBm25(_query: string, topK: number): Promise<SearchHit[]> {
    return this.bm25Hits.slice(0, topK);
  }

  async searchVector(_query: string, topK: number): Promise<SearchHit[]> {
    return this.vecHits.slice(0, topK);
  }
}

// ─── 헬퍼 ───────────────────────────────────────────

function makeHit(
  chunkId: string,
  rank: number,
  source: "bm25" | "vec",
  overrides: Partial<SearchHit> = {},
): SearchHit {
  return {
    source,
    chunkId,
    docId: `doc-${chunkId}`,
    docName: `Document ${chunkId}`,
    page: 1,
    rawText: `text for ${chunkId}`,
    rank,
    score: 1.0 - rank * 0.1,
    ...overrides,
  };
}

function expectApprox(actual: number, expected: number, epsilon = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon);
}

// ─── Test cases ─────────────────────────────────────

describe("SECURITY_GATE: HybridRetriever RRF 수학", () => {
  it("RRF default k=60 is 60", () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  it("case 1: bm25 rank0 + vec rank0 same chunkId → 2 * 0.5/(60+1) ≈ 0.01639344", async () => {
    const bm25 = [makeHit("chunk-A", 0, "bm25")];
    const vec = [makeHit("chunk-A", 0, "vec")];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, vec),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("test", 5);
    expect(results.length).toBe(1);
    const expected = 0.5 * (1 / (60 + 0 + 1)) + 0.5 * (1 / (60 + 0 + 1));
    expectApprox(results[0].rrfScore, expected);
    expectApprox(results[0].rrfScore, 0.01639344, 1e-6);
    expect(results[0].sources.length).toBe(2);
    expect(results[0].chunkId).toBe("chunk-A");
  });

  it("case 2: bm25 rank0 + vec rank4 same chunkId → 0.5/61 + 0.5/65 ≈ 0.01588903", async () => {
    const bm25 = [makeHit("chunk-B", 0, "bm25")];
    const vec: SearchHit[] = [
      makeHit("vec-d1", 0, "vec"),
      makeHit("vec-d2", 1, "vec"),
      makeHit("vec-d3", 2, "vec"),
      makeHit("vec-d4", 3, "vec"),
      makeHit("chunk-B", 4, "vec"),
    ];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, vec),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("test", 10);
    const b = results.find((r) => r.chunkId === "chunk-B");
    expect(b).toBeDefined();
    const expected = 0.5 * (1 / (60 + 0 + 1)) + 0.5 * (1 / (60 + 4 + 1));
    expectApprox(b!.rrfScore, expected);
    expectApprox(b!.rrfScore, 0.01588903, 1e-6);
    expect(b!.sources.length).toBe(2);
  });

  it("case 3: cloud Mock (weight 0) yields no cloud sources", async () => {
    const bm25 = [makeHit("chunk-C", 0, "bm25")];
    const vec = [makeHit("chunk-C", 0, "vec")];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, vec),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("q", 5);
    expect(results.length).toBe(1);
    const sources = results[0].sources.map((s) => s.source);
    expect(sources).not.toContain("cloud");
  });

  it("case 4: all empty retrievers → []", async () => {
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient([], []),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("q", 5);
    expect(results).toEqual([]);
  });

  it("case 5: topK slicing is exact + desc sorted", async () => {
    const bm25 = Array.from({ length: 20 }, (_, i) =>
      makeHit(`ch-${i}`, i, "bm25"),
    );
    const vec = Array.from({ length: 20 }, (_, i) =>
      makeHit(`ch-${i}`, i, "vec"),
    );
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, vec),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("q", 3);
    expect(results.length).toBe(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rrfScore).toBeGreaterThanOrEqual(results[i].rrfScore);
    }
    expect(results[0].chunkId).toBe("ch-0");
    expect(results[1].chunkId).toBe("ch-1");
    expect(results[2].chunkId).toBe("ch-2");
  });

  it("case 6: distinct chunkIds aggregate independently", async () => {
    const bm25 = [makeHit("alpha", 0, "bm25"), makeHit("beta", 1, "bm25")];
    const vec = [makeHit("beta", 0, "vec"), makeHit("gamma", 1, "vec")];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, vec),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("q", 10);
    const byId = new Map(results.map((r) => [r.chunkId, r]));
    expect(results.length).toBe(3);
    expectApprox(byId.get("alpha")!.rrfScore, 0.5 * (1 / (60 + 0 + 1)));
    expectApprox(
      byId.get("beta")!.rrfScore,
      0.5 * (1 / (60 + 1 + 1)) + 0.5 * (1 / (60 + 0 + 1)),
    );
    expectApprox(byId.get("gamma")!.rrfScore, 0.5 * (1 / (60 + 1 + 1)));
    expect(results[0].chunkId).toBe("beta");
  });

  it("case 7: empty query returns []", async () => {
    const bm25 = [makeHit("ch-Z", 0, "bm25")];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, []),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    expect(await retriever.retrieve("", 5)).toEqual([]);
    expect(await retriever.retrieve("   ", 5)).toEqual([]);
  });

  it("case 8: topK<=0 returns []", async () => {
    const bm25 = [makeHit("ch-Z", 0, "bm25")];
    const retriever = new HybridRetriever({
      workerClient: new StubWorkerClient(bm25, []),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    expect(await retriever.retrieve("q", 0)).toEqual([]);
    expect(await retriever.retrieve("q", -5)).toEqual([]);
  });

  it("case 9: worker bm25 failure → degrades to vec only", async () => {
    class FlakyClient implements WorkerSearchClient {
      async searchBm25(): Promise<SearchHit[]> {
        throw new Error("bm25 simulated failure");
      }
      async searchVector(): Promise<SearchHit[]> {
        return [makeHit("vec-only", 0, "vec")];
      }
    }
    const retriever = new HybridRetriever({
      workerClient: new FlakyClient(),
      cloudAdapter: new MockCloudIndexAdapter(),
    });
    const results = await retriever.retrieve("q", 5);
    expect(results.length).toBe(1);
    expect(results[0].chunkId).toBe("vec-only");
  });
});
