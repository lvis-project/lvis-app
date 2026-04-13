/**
 * MockCloudIndexAdapter — Phase 1 빈 결과 계약 검증
 *
 * 청사진 §6.1: `lvis-app/src/main/cloud-index-adapter.ts`
 * 청사진 §1 C4: Phase 1 cloud weight = 0.0
 *
 * 실행: npm test (vitest)
 */
import { describe, it, expect } from "vitest";
import { MockCloudIndexAdapter } from "../cloud-index-adapter.js";

describe("MockCloudIndexAdapter", () => {
  it("search() returns empty array (any query)", async () => {
    const adapter = new MockCloudIndexAdapter();
    const hits = await adapter.search("any query", 10);
    expect(hits).toEqual([]);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("search() handles topK=0", async () => {
    const adapter = new MockCloudIndexAdapter();
    const hits = await adapter.search("q", 0);
    expect(hits).toEqual([]);
  });

  it("isAvailable() returns false in Phase 1", async () => {
    const adapter = new MockCloudIndexAdapter();
    expect(await adapter.isAvailable()).toBe(false);
  });

  it("search() is idempotent across multiple calls", async () => {
    const adapter = new MockCloudIndexAdapter();
    const first = await adapter.search("q1", 5);
    const second = await adapter.search("q2", 5);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });
});
