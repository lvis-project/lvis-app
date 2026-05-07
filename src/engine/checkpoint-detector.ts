/**
 * Checkpoint Detector — §PR-3
 *
 * Stream 에서 `<title>X</title>` + `[checkpoint]` 마커를 추출하고
 * cleaned text (마커 제거)를 반환한다.
 *
 * 마커 어휘 정정 (2026-05-07): `[checkpoint-suggested]` → `[checkpoint]`.
 * "suggested" 라는 단어가 LLM 의 conservatism 을 강화해 마커가 거의 발화
 * 되지 않는 incident 발생 — 이는 *제안*이 아니라 LLM 자체 판단의 결정
 * 사항임을 명확히 하기 위해 어휘 단순화. 구 마커도 한동안 backward-compat
 * 으로 인식한다.
 */

export interface DetectorResult {
  /** <title>...</title> + [checkpoint] 마커가 제거된 최종 답변 */
  cleanedText: string;
  /** 추출된 신규 제목 (없으면 null). 10-20자 트림 적용. */
  newTitle: string | null;
  /**
   * [checkpoint] (또는 legacy [checkpoint-suggested]) 마커 발견 여부.
   * 이름은 호환성 위해 유지하되 의미는 "LLM 이 결정한 checkpoint" 로 격상.
   */
  checkpointSuggested: boolean;
}

const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/gi;
const CHECKPOINT_MARKER = "[checkpoint]";
const CHECKPOINT_MARKER_LEGACY = "[checkpoint-suggested]";

const TITLE_MIN = 10;
const TITLE_MAX = 20;

/**
 * rawText 에서 `<title>...</title>` (마지막 occurrence) 과
 * `[checkpoint-suggested]` 를 추출하고 제거한 cleaned text 를 반환한다.
 *
 * - 다중 `<title>` 태그가 있으면 마지막 것만 strip/extract 한다.
 *   앞쪽 `<title>` 블록은 사용자가 inline으로 작성한 내용일 수 있으므로 보존.
 * - title 내용이 TITLE_MIN 미만이거나 불완전한 태그면 null.
 * - TITLE_MAX 초과 시 TITLE_MAX 자로 truncate.
 */
export function detectFromStream(rawText: string): DetectorResult {
  let newTitle: string | null = null;
  let checkpointSuggested = false;

  // [checkpoint] (or legacy [checkpoint-suggested]) 검색
  if (
    rawText.includes(CHECKPOINT_MARKER) ||
    rawText.includes(CHECKPOINT_MARKER_LEGACY)
  ) {
    checkpointSuggested = true;
  }

  // <title>...</title> — 모든 occurrence 찾아 마지막 사용
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  const re = new RegExp(TITLE_PATTERN.source, "gi");
  while ((match = re.exec(rawText)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const raw = lastMatch[1].trim();
    if (raw.length >= TITLE_MIN) {
      newTitle = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX) : raw;
    }
  }

  // 마커가 없으면 원문 그대로 반환 — 불필요한 텍스트 변형 방지
  if (!lastMatch && !checkpointSuggested) {
    return { cleanedText: rawText, newTitle: null, checkpointSuggested: false };
  }

  // cleaned text: 마지막 <title>...</title> 블록만 strip (앞쪽 블록은 사용자 콘텐츠로 보존).
  // [checkpoint-suggested] 는 전체 텍스트에서 제거.
  let cleaned: string;
  if (lastMatch) {
    // lastMatch.index + lastMatch[0].length 로 마지막 블록의 위치를 특정해 제거
    cleaned =
      rawText.slice(0, lastMatch.index) +
      rawText.slice(lastMatch.index + lastMatch[0].length);
  } else {
    cleaned = rawText;
  }
  cleaned = cleaned.split(CHECKPOINT_MARKER).join("");
  cleaned = cleaned.split(CHECKPOINT_MARKER_LEGACY).join("");
  // 연속 공백/빈줄 정리
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedText: cleaned, newTitle, checkpointSuggested };
}
