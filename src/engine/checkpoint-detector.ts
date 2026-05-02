/**
 * Checkpoint Detector — §PR-3
 *
 * Stream 에서 `<title>X</title>` + `[checkpoint-suggested]` 마커를 추출하고
 * cleaned text (마커 제거)를 반환한다.
 */

export interface DetectorResult {
  /** <title>...</title> + [checkpoint-suggested] 마커가 제거된 최종 답변 */
  cleanedText: string;
  /** 추출된 신규 제목 (없으면 null). 10-20자 트림 적용. */
  newTitle: string | null;
  /** [checkpoint-suggested] 마커 발견 여부 */
  checkpointSuggested: boolean;
}

const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/gi;
const CHECKPOINT_MARKER = "[checkpoint-suggested]";

const TITLE_MIN = 10;
const TITLE_MAX = 20;

/**
 * rawText 에서 `<title>...</title>` (마지막 occurrence) 과
 * `[checkpoint-suggested]` 를 추출하고 제거한 cleaned text 를 반환한다.
 *
 * - 다중 `<title>` 태그가 있으면 마지막 것을 사용한다.
 * - title 내용이 TITLE_MIN 미만이거나 불완전한 태그면 null.
 * - TITLE_MAX 초과 시 TITLE_MAX 자로 truncate.
 */
export function detectFromStream(rawText: string): DetectorResult {
  let newTitle: string | null = null;
  let checkpointSuggested = false;

  // [checkpoint-suggested] 검색
  if (rawText.includes(CHECKPOINT_MARKER)) {
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

  // cleaned text: 마커 발견 시에만 <title>...</title> + [checkpoint-suggested] 제거
  let cleaned = rawText.replace(/<title>[\s\S]*?<\/title>/gi, "");
  cleaned = cleaned.split(CHECKPOINT_MARKER).join("");
  // 연속 공백/빈줄 정리
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedText: cleaned, newTitle, checkpointSuggested };
}
