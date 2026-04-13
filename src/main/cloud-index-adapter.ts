/**
 * Cloud Index Adapter — Phase 1 Mock
 *
 * 향후 사내 Server Index Engine (Elasticsearch + Milvus/Qdrant) 클라이언트로
 * 교체될 인터페이스. Phase 1에서는 빈 결과 + 구조화 로그만 반환한다.
 *
 * 청사진 §1 C4: Phase 1 cloud weight = 0.0 (bm25:0.5 + vec:0.5 로 재정규화)
 * 청사진 §6.1: `lvis-app/src/main/cloud-index-adapter.ts`
 *
 * INTEGRATION NOTE for Agent 4 (Plugin Integrator):
 * boot.ts bootstrap()에서:
 *   import { MockCloudIndexAdapter } from "./main/cloud-index-adapter.js";
 *   const cloudAdapter = new MockCloudIndexAdapter();
 *   // 이후 HybridRetriever 생성 시 주입
 */

// ─── 타입 ────────────────────────────────────────────

export interface CloudIndexHit {
  source: "cloud";
  docId: string;
  docName: string;
  /** 미리보기용 짧은 스니펫 (≤ 200자 권장) */
  snippet: string;
  /** 서버 측 원본 URL (있으면 표시에 활용) */
  url?: string;
  /** 서버 측 원본 score (정규화되지 않음) */
  score: number;
}

/**
 * Cloud Index Adapter 인터페이스.
 * Phase 2에서 사내 Server Index Engine 실연결 클라이언트가 이 인터페이스를 구현한다.
 */
export interface CloudIndexAdapter {
  /**
   * 질의어로 클라우드 인덱스 검색.
   * 실패/타임아웃 시 빈 배열을 반환하거나 throw해도 무방 —
   * HybridRetriever가 Promise.race 타임아웃으로 감싸기 때문.
   */
  search(query: string, topK: number): Promise<CloudIndexHit[]>;

  /**
   * 헬스체크. 사용자 설정에서 'cloud.enabled'가 켜져 있고
   * 네트워크 접근이 가능한 경우에만 true.
   */
  isAvailable(): Promise<boolean>;
}

// ─── Phase 1 Mock 구현 ──────────────────────────────

/**
 * Mock Cloud Index Adapter — Phase 1.
 *
 * 모든 검색 요청에 빈 배열을 반환한다. 이로써 HybridRetriever는
 * bm25 + vec 두 개 소스만으로 작동하고, cloud weight=0 정규화가 성립한다.
 *
 * Phase 1.5에서 실클라이언트로 교체되면 HybridRetriever 생성자의
 * weights 기본값을 {bm25:0.35, vec:0.35, cloud:0.3}로 바꾸면 된다.
 */
export class MockCloudIndexAdapter implements CloudIndexAdapter {
  async search(_query: string, _topK: number): Promise<CloudIndexHit[]> {
    // 의도적으로 빈 결과. 로그는 HybridRetriever 쪽에서 기록.
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
