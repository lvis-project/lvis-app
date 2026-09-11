// Stream collection catalog fragment, consumed by the generated locale barrels.
export const en = {
  "be_streamCollector.streamError": "Error: {userMessage}",
  "be_streamCollector.streamEndedWithoutCompletion": "Error: Model stream ended without a completion signal. Please try again.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_streamCollector.streamError": "오류: {userMessage}",
  "be_streamCollector.streamEndedWithoutCompletion": "오류: 모델 응답이 완료 신호 없이 종료되었습니다. 다시 시도해 주세요.",
};
