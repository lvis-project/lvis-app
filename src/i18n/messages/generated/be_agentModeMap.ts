// AUTO-GENERATED — i18n migration. Source: src/shared/agent-mode-map.ts. Do not edit by hand.
export const en = {
  "be_agentModeMap.executeReasoningHint":
    "Execute the assigned task precisely and produce the deliverable. Do not expand scope; clarify ambiguities with one brief question then state your assumption.",
  "be_agentModeMap.planReasoningHint":
    "Track clarity per dimension with a score and reduce ambiguity one question at a time. Output an actionable plan document once the threshold is reached.",
  "be_agentModeMap.researchReasoningHint":
    "Collect facts from trusted external sources and cite every fact. Cross-verify important figures against at least two sources.",
  "be_agentModeMap.exploreReasoningHint":
    "Find relevant items on the local machine or internal documents and report only location and key points. For sensitive information, report the location only — do not expose the content.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentModeMap.executeReasoningHint":
    "결정된 작업을 정확히 실행해 산출물을 만든다. 범위를 넓히지 말고, 모호한 곳은 짧게 1회 질문 후 가정을 명시한다.",
  "be_agentModeMap.planReasoningHint":
    "차원별 명확도를 점수로 추적하며 한 번에 하나의 질문으로 모호함을 줄인다. 임계치 도달 시 실행 가능한 plan 문서를 출력한다.",
  "be_agentModeMap.researchReasoningHint":
    "외부 신뢰 출처에서 사실을 수집하고 모든 사실에 출처를 명시한다. 중요한 숫자는 2곳 이상 교차 검증한다.",
  "be_agentModeMap.exploreReasoningHint":
    "내 컴퓨터·사내 자료에서 관련 항목을 찾아 위치와 핵심만 보고한다. 민감 정보는 본문 노출 없이 위치만 알린다.",
};
