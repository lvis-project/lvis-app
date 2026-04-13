/**
 * MockCloudIndexAdapter — Phase 1 빈 결과 계약 검증
 *
 * 청사진 §6.1: `lvis-app/src/main/cloud-index-adapter.ts`
 * 청사진 §1 C4: Phase 1 cloud weight = 0.0
 *
 * 실행:
 *   cd lvis-app && npx tsx src/main/__tests__/cloud-index-adapter.test.ts
 */

import { strict as assert } from "node:assert";
import { MockCloudIndexAdapter } from "../cloud-index-adapter.js";

async function main(): Promise<void> {
  const adapter = new MockCloudIndexAdapter();

  // 1) search는 빈 배열을 반환
  const hits = await adapter.search("any query", 10);
  assert.deepEqual(hits, [], "search should return empty array");
  assert.equal(Array.isArray(hits), true);

  // 2) 빈 topK도 무방
  const hitsZero = await adapter.search("q", 0);
  assert.deepEqual(hitsZero, []);

  // 3) isAvailable → false (Phase 1)
  const available = await adapter.isAvailable();
  assert.equal(available, false);

  // 4) 여러 번 호출해도 일관성 (idempotent)
  const again = await adapter.search("q2", 5);
  assert.deepEqual(again, []);

  console.log("  PASS  MockCloudIndexAdapter.search returns []");
  console.log("  PASS  MockCloudIndexAdapter.isAvailable returns false");
  console.log();
  console.log("Total: 4, Passed: 4, Failed: 0");
}

console.log("CloudIndexAdapter Mock tests");
console.log("=============================");
main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
