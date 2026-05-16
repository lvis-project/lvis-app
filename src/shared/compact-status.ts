/**
 * CompressionStatus — 사용자 가시 compact 결과 분류.
 *
 * 사용자 contract: "compact MUST always reduce on any input"
 * (수동 삭제 없이 어떤 input 도 reduce). 이 contract 를 만족시키려면
 * compact 결과를 단순 success/failure 가 아닌 다음 4 상태로 구분한다:
 *
 *   - `SUMMARIZED` — 정상 LLM 구조화 요약. 가장 일반적인 결과.
 *   - `CONTENT_TRUNCATED` — per-message truncation + reverse-budget truncation
 *     만으로 충분히 reduce 되어 LLM 호출 skip. 단일 거대 tool_result 가
 *     temp 파일로 격리된 케이스. 사용자에게 원본 경로를 노출.
 *   - `NOOP` — history 가 충분히 작아서 reduce 불필요. preserveRecent 안에
 *     모두 들어가는 정상 케이스. 사용자에게 안내 메시지.
 *   - `REDUCED_INSUFFICIENT_FORCED` — truncation + summary 모두 동작 후에도 over-budget
 *     (LLM summary 실패 또는 boundary stub 자체가 거대). last-resort 로
 *     oldest 50% 강제 raw truncation. 사용자에게 명시적 경고.
 *
 * Renderer 는 status 별로 다른 시각 variant (색상/아이콘/메시지) 를 표시한다.
 * IPC 페이로드 `compact_notice.compactStatus` 로 plumb.
 */
export enum CompressionStatus {
  SUMMARIZED = "summarized",
  CONTENT_TRUNCATED = "content_truncated",
  NOOP = "noop",
  REDUCED_INSUFFICIENT_FORCED = "reduced_insufficient_forced",
}

/**
 * Per-message truncation 임계. 단일 메시지가 이 토큰 수를 초과하면
 * compactWithBoundary 진입 전에 truncation pre-pass 가 발동한다.
 * LVIS oversize-message guard threshold.
 */
export const TRUNCATION_THRESHOLD_TOKENS = 30_000;

/**
 * Truncated 메시지의 보존 라인 수. 메시지 끝에서부터 이 만큼의 라인을
 * 유지하고 그 외는 temp 파일 (~/.lvis/sessions/<id>/truncated/) 로 격리.
 * LVIS keeps the last N lines inline and stores the full body in an archive.
 */
export const TRUNCATION_PRESERVED_LINES = 30;
