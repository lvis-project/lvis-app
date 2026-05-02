/**
 * Title Chainer — §PR-3
 *
 * 기존 세션 제목 + 이번 답변을 조합하여 LLM mini-call 로 새 제목을 생성한다.
 * max 30 tokens 제한. 결과가 10-20자 범위 밖이면 null 반환.
 */

import type { LLMProvider } from "./llm/types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("title-chainer");

const TITLE_MIN = 10;
const TITLE_MAX = 20;

/**
 * mini-call: 기존 제목 + 최신 답변 앞 500자로 10-20자 제목 생성.
 * LLM 응답이 비어있거나 길이 초과 시 null 반환 (truncate > TITLE_MAX).
 */
export async function chainTitle(
  llm: LLMProvider,
  existingTitle: string,
  finalAnswer: string,
): Promise<string | null> {
  if (!finalAnswer.trim()) return null;

  const excerpt = finalAnswer.slice(0, 500);
  const prompt = `기존 제목 '${existingTitle}' + 이번 답변 '${excerpt}' 종합한 10-20자 제목:`;

  try {
    let text = "";
    for await (const ev of llm.streamTurn({
      model: "gpt-4o-mini", // mini-call — caller may override via wrapper
      systemPrompt: "당신은 대화 제목 생성 도우미입니다. 10-20자의 짧은 제목만 출력하세요.",
      messages: [{ role: "user", content: prompt }],
      tools: [],
    })) {
      if (ev.type === "text_delta" && ev.text) text += ev.text;
      if (ev.type === "message_complete") break;
      if (ev.type === "error") {
        log.warn("chainTitle: LLM stream error: %s", ev.error);
        return null;
      }
    }

    const cleaned = stripQuotes(text.trim());
    if (!cleaned) return null;
    if (cleaned.length > TITLE_MAX) return cleaned.slice(0, TITLE_MAX);
    if (cleaned.length < TITLE_MIN) return null;
    return cleaned;
  } catch (err) {
    log.warn("chainTitle: LLM call failed: %s", err);
    return null;
  }
}

/** LLM 응답에서 따옴표·공백 제거 */
function stripQuotes(text: string): string {
  return text.replace(/^["'「『【"']+|["'」』】"']+$/g, "").trim();
}
