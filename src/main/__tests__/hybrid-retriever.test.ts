/**
 * HybridRetriever — RRF 수학 검증 테스트
 *
 * 청사진 §1 C4: RRF k=60, weights {bm25:0.5, vec:0.5, cloud:0.0}
 * 청사진 §6.5: `lvis-app/src/main/__tests__/hybrid-retriever.test.ts`
 *
 * 실행:
 *   cd lvis-app && npx tsx src/main/__tests__/hybrid-retriever.test.ts
 *
 * 프로젝트에 vitest가 설치되어 있지 않아 node:assert + 수동 러너 패턴을 사용.
 * 기존 `scripts/test-openai-provider.ts` 스타일을 따름.
 *
 * 검증 케이스:
 *   1) RRF 수학 정확성 — bm25 rank 0 + vec rank 0 동일 chunkId → ≈ 0.0164
 *   2) RRF 수학 정확성 — bm25 rank 0 + vec rank 4 동일 chunkId → ≈ 0.0159
 *   3) cloud Mock (weight 0) → 결합 결과에 cloud source 미포함
 *   4) 빈 결과 처리 — 모든 retriever 빈 배열 → []
 *   5) topK 잘림 정확
 *   6) 소스별 분리 — 서로 다른 chunkId는 독립 aggregate
 */

import { strict as assert } from "node:assert";

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

// ─── 러너 ───────────────────────────────────────────

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

async function runAll(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(err as Error).message}`);
      if ((err as Error).stack) {
        console.error(
          (err as Error).stack!.split("\n").slice(1, 4).join("\n"),
        );
      }
      failed++;
    }
  }
  console.log();
  console.log(`Total: ${tests.length}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
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

function approxEqual(a: number, b: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(a - b) < epsilon,
    `expected ${a} ≈ ${b} (within ${epsilon}), got diff ${Math.abs(a - b)}`,
  );
}

// ─── Test cases ─────────────────────────────────────

test("RRF default k=60 is 60", async () => {
  assert.equal(DEFAULT_RRF_K, 60);
});

test("case 1: bm25 rank0 + vec rank0 same chunkId → 2 * 0.5/(60+1) ≈ 0.01639344", async () => {
  const bm25 = [makeHit("chunk-A", 0, "bm25")];
  const vec = [makeHit("chunk-A", 0, "vec")];
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient(bm25, vec),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  const results = await retriever.retrieve("test", 5);
  assert.equal(results.length, 1, "single merged result");
  const expected = 0.5 * (1 / (60 + 0 + 1)) + 0.5 * (1 / (60 + 0 + 1));
  approxEqual(results[0].rrfScore, expected);
  // 대략치도 함께 확인
  approxEqual(results[0].rrfScore, 0.01639344, 1e-6);
  assert.equal(results[0].sources.length, 2);
  assert.equal(results[0].chunkId, "chunk-A");
});

test("case 2: bm25 rank0 + vec rank4 same chunkId → 0.5/61 + 0.5/65 ≈ 0.01588903", async () => {
  const bm25 = [makeHit("chunk-B", 0, "bm25")];
  // vec 결과에서 chunk-B를 rank 4(인덱스 4)에 놓으려면 앞에 더미 4개 필요
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
  assert.ok(b, "chunk-B present");
  const expected = 0.5 * (1 / (60 + 0 + 1)) + 0.5 * (1 / (60 + 4 + 1));
  approxEqual(b!.rrfScore, expected);
  approxEqual(b!.rrfScore, 0.01588903, 1e-6);
  assert.equal(b!.sources.length, 2);
});

test("case 3: cloud Mock (weight 0) yields no cloud sources", async () => {
  const bm25 = [makeHit("chunk-C", 0, "bm25")];
  const vec = [makeHit("chunk-C", 0, "vec")];
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient(bm25, vec),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  const results = await retriever.retrieve("q", 5);
  assert.equal(results.length, 1);
  const sources = results[0].sources.map((s) => s.source);
  assert.ok(!sources.includes("cloud"), "cloud must not appear");
});

test("case 4: all empty retrievers → []", async () => {
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient([], []),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  const results = await retriever.retrieve("q", 5);
  assert.deepEqual(results, []);
});

test("case 5: topK slicing is exact", async () => {
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
  assert.equal(results.length, 3);
  // 내림차순 정렬 확인
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].rrfScore >= results[i].rrfScore,
      `results must be sorted desc at i=${i}`,
    );
  }
  // 상위 3개는 ch-0, ch-1, ch-2 여야 함 (rank 0,1,2 가 가장 높은 기여)
  assert.equal(results[0].chunkId, "ch-0");
  assert.equal(results[1].chunkId, "ch-1");
  assert.equal(results[2].chunkId, "ch-2");
});

test("case 6: distinct chunkIds aggregate independently", async () => {
  const bm25 = [makeHit("alpha", 0, "bm25"), makeHit("beta", 1, "bm25")];
  const vec = [makeHit("beta", 0, "vec"), makeHit("gamma", 1, "vec")];
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient(bm25, vec),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  const results = await retriever.retrieve("q", 10);
  const byId = new Map(results.map((r) => [r.chunkId, r]));
  assert.equal(results.length, 3);
  // alpha: bm25 rank 0만
  approxEqual(byId.get("alpha")!.rrfScore, 0.5 * (1 / (60 + 0 + 1)));
  // beta: bm25 rank 1 + vec rank 0
  approxEqual(
    byId.get("beta")!.rrfScore,
    0.5 * (1 / (60 + 1 + 1)) + 0.5 * (1 / (60 + 0 + 1)),
  );
  // gamma: vec rank 1만
  approxEqual(byId.get("gamma")!.rrfScore, 0.5 * (1 / (60 + 1 + 1)));
  // beta가 가장 높은 score
  assert.equal(results[0].chunkId, "beta");
});

test("case 7: empty query returns []", async () => {
  const bm25 = [makeHit("ch-Z", 0, "bm25")];
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient(bm25, []),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  assert.deepEqual(await retriever.retrieve("", 5), []);
  assert.deepEqual(await retriever.retrieve("   ", 5), []);
});

test("case 8: topK<=0 returns []", async () => {
  const bm25 = [makeHit("ch-Z", 0, "bm25")];
  const retriever = new HybridRetriever({
    workerClient: new StubWorkerClient(bm25, []),
    cloudAdapter: new MockCloudIndexAdapter(),
  });
  assert.deepEqual(await retriever.retrieve("q", 0), []);
  assert.deepEqual(await retriever.retrieve("q", -5), []);
});

test("case 9: worker bm25 failure → degrades to vec only", async () => {
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
  assert.equal(results.length, 1);
  assert.equal(results[0].chunkId, "vec-only");
});

// ─── main ──────────────────────────────────────────

console.log("HybridRetriever RRF math tests");
console.log("================================");
runAll().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
