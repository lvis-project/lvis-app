/**
 * Checkpoint Detector — assistant final answer 끝에 LLM 이 직접 결정해
 * 삽입한 `<title>...</title>` + `[checkpoint]` 마커를 추출하고 cleaned
 * text (마커 제거된 본문) 를 반환한다.
 */

export interface DetectorResult {
  cleanedText: string;
  /** 10-20자 트림된 신규 세션 제목. 추출 실패 시 null. */
  newTitle: string | null;
  /** `[checkpoint]` 마커 발견 여부 — LLM 이 turn 종료를 결정한 신호. */
  checkpointSuggested: boolean;
}

const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/gi;
const CHECKPOINT_MARKER = "[checkpoint]";
const TITLE_MIN = 10;
const TITLE_MAX = 20;

export function detectFromStream(rawText: string): DetectorResult {
  const checkpointSuggested = rawText.includes(CHECKPOINT_MARKER);

  // 다중 <title> 태그가 있으면 마지막 것만 마커로 사용. 앞쪽 블록은
  // 사용자 인용일 수 있어 보존.
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  const re = new RegExp(TITLE_PATTERN.source, "gi");
  while ((match = re.exec(rawText)) !== null) {
    lastMatch = match;
  }

  let newTitle: string | null = null;
  if (lastMatch) {
    const raw = lastMatch[1].trim();
    if (raw.length >= TITLE_MIN) {
      newTitle = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX) : raw;
    }
  }

  if (!lastMatch && !checkpointSuggested) {
    return { cleanedText: rawText, newTitle: null, checkpointSuggested: false };
  }

  let cleaned = lastMatch
    ? rawText.slice(0, lastMatch.index) +
      rawText.slice(lastMatch.index + lastMatch[0].length)
    : rawText;
  cleaned = cleaned.split(CHECKPOINT_MARKER).join("");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedText: cleaned, newTitle, checkpointSuggested };
}
