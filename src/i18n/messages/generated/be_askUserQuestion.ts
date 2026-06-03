// AUTO-GENERATED — i18n migration. Source: src/tools/ask-user-question.ts. Do not edit by hand.
export const en = {
  "be_askUserQuestion.toolDescription":
    "Ask the user 1–4 related questions grouped into a single card and wait for answers. " +
    "Once the user answers all questions and confirms on the final review page, all responses are returned at once. " +
    "Each question is a combination of multiple-choice (choices, up to 3, ≤ 20 chars per item) + free text (allowFreeText, single-line). " +
    "Only assign a recommendedIndex for the choice with clear contextual weight (0 or 1 total). Other suggestions go in altIndices (0–N items) — the UI automatically attaches 'Recommend' / 'Alt' badges to the chips. " +
    "If the answer is private or external user information (location, preference, etc.), leave both recommendedIndex and altIndices empty. " +
    "Setting allowMultiple=true lets the user select multiple choices simultaneously; responses come back as answers[].choices: string[] (default false — single select, answers[].choice: string). " +
    "placeholder is a hint for the free-text input (≤ 20 chars), summaryHint is the row label on the confirm step (≤ 10 chars). " +
    "If not confirmed within 5 minutes, returns dismissed=true.",
  "be_askUserQuestion.questionsDesc":
    "1–{max} questions to ask the user together in a single card. " +
    "The user answers them one by one via pagination and submits all at once on the final confirm page.",
  "be_askUserQuestion.questionItemDesc": "The question text shown to the user (one or two lines).",
  "be_askUserQuestion.choicesDesc":
    "Answer choices shown as buttons. Up to 3, ≤ 20 chars per item. " +
    "Other answers can be supplemented via free text, so even if there are more than 4 candidates provide only the top 3 most likely. " +
    "Static fallbacks ('Yes'/'No'/'Not sure') are prohibited — provide specific choices appropriate to the context of that branch. " +
    "Empty or omitted shows free-text input only.",
  "be_askUserQuestion.recommendedIndexDesc":
    "Index of the choice the model most recommends (0–2, since choices has at most 3 items). " +
    "Only assign when one answer has clear contextual weight — 0 or 1 items total. " +
    "Leave empty if the answer is private or external user information (location, preference, etc.). " +
    "Values outside the choices array length are ignored at runtime.",
  "be_askUserQuestion.altIndicesDesc":
    "Array of indices for secondary recommended choices (0–N, up to choices length). " +
    "The UI automatically attaches a gray 'Alt' badge to those chips. " +
    "Values that duplicate recommendedIndex or fall outside choices length are ignored at runtime.",
  "be_askUserQuestion.allowFreeTextDesc": "Whether free text input is allowed. Default true (single-line input).",
  "be_askUserQuestion.allowMultipleDesc":
    "Multi-select mode allowing multiple choices to be selected at once. Default false (single select). " +
    "When true, responses come as answers[].choices: string[] (array of selected labels); when false, answers[].choice: string. " +
    "Use only for questions where multiple candidates can be correct simultaneously (interests, tags, ranges, etc.). " +
    "Keep false for single-answer questions.",
  "be_askUserQuestion.placeholderDesc":
    "Placeholder hint for the free-text input (≤ 20 chars). " +
    "Example: 'Describe another direction'. Do not embed meta labels like 'Recommend'/'(Alt)' in the text — the UI attaches those automatically.",
  "be_askUserQuestion.summaryHintDesc":
    "Row label shown next to the answer on the confirm step of a multi-question card (≤ 10 chars). " +
    "Example: 'Direction', 'Target'. If omitted, the question itself is truncated for use.",
  "be_askUserQuestion.suggestedAnswersDesc":
    "[deprecated — use choices + recommendedIndex/altIndices instead] " +
    "Accepted for backward compatibility only; ignored when choices is present. " +
    "Do not use in new calls.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_askUserQuestion.toolDescription":
    "사용자에게 1~4개의 관련 질문을 한 카드로 묶어서 묻고 답을 기다립니다. " +
    "사용자가 모든 질문에 답한 뒤 최종 확인 페이지에서 컨펌하면 응답이 한꺼번에 반환됩니다. " +
    "각 질문은 객관식(choices, 최대 3개, 항목당 한국어 ≤ 20자) + 자유 입력(allowFreeText, single-line) 조합. " +
    "컨텍스트로 명확히 한 답에 weight 가 있을 때만 그 인덱스를 recommendedIndex 로 표기 (전체 0 또는 1개). 그 외에 추가로 권장하고 싶은 답은 altIndices 에 0~N 개 — UI 가 칩 앞쪽에 'Recommend' / '대안' 배지를 자동 부착합니다. " +
    "사용자의 사적/외부 사실(거주지·취향 등)이 답이라면 recommendedIndex 와 altIndices 모두 비워두세요. " +
    "allowMultiple=true 로 두면 사용자가 choices 중 여러 개를 동시에 선택할 수 있고 응답은 answers[].choices 배열로 돌아옵니다 (기본 false — 단일 선택, answers[].choice 단일 문자열). " +
    "placeholder 는 자유입력 단서(한국어 ≤ 20자), summaryHint 는 confirm 단계 표 row label (≤ 10자). " +
    "5분 안에 확인이 없으면 dismissed=true 로 반환.",
  "be_askUserQuestion.questionsDesc":
    "한 카드 안에서 사용자에게 묶어 물을 질문 1~{max}개. " +
    "사용자는 페이지네이션으로 차례로 답하고 마지막 컨펌 페이지에서 한꺼번에 제출.",
  "be_askUserQuestion.questionItemDesc": "사용자에게 보여줄 질문 본문 (한 줄 또는 두 줄).",
  "be_askUserQuestion.choicesDesc":
    "버튼으로 보여줄 선택지. 최대 3개, 항목당 한국어 ≤ 20자. " +
    "그 외 답은 자유 입력으로 사용자가 보완하므로 4개 이상 후보가 있어도 가장 가능성 높은 3개만 두세요. " +
    "정적 폴백('네'/'아니오'/'잘 모르겠어요')은 금지 — 그 분기점의 맥락에 맞는 구체적 선택지를 제시하세요. " +
    "비어 있거나 생략 시 자유 입력만 표시.",
  "be_askUserQuestion.recommendedIndexDesc":
    "choices 중 모델이 가장 권장하는 항목의 인덱스 (0~2, choices 가 최대 3개이므로). " +
    "컨텍스트로 명확히 한 답에 weight 가 있을 때만 0개 또는 1개 항목에 부여. " +
    "사용자의 사적/외부 사실(거주지·취향 등)이 답이면 비워두세요. " +
    "choices 길이를 벗어난 값은 런타임에서 무시됩니다.",
  "be_askUserQuestion.altIndicesDesc":
    "choices 중 보조 권장 항목의 인덱스 배열 (0~N, choices 길이까지). " +
    "UI 가 칩 앞쪽에 회색 '대안' 배지를 자동 부착합니다. " +
    "recommendedIndex 와 중복되거나 choices 길이를 벗어난 값은 런타임에서 무시됩니다.",
  "be_askUserQuestion.allowFreeTextDesc": "자유 텍스트 입력 허용 여부. 기본 true (single-line input).",
  "be_askUserQuestion.allowMultipleDesc":
    "여러 항목을 동시에 선택 가능한 다중 선택 모드. 기본 false (단일 선택). " +
    "true 일 때 응답은 answers[].choices: string[] (선택 라벨 배열), false 일 때 answers[].choice: string. " +
    "여러 후보가 동시에 답이 될 수 있는 질문(관심사·태그·범위 등)에만 사용하세요. " +
    "단일 선택 질문에는 false 로 두세요.",
  "be_askUserQuestion.placeholderDesc":
    "자유입력 input 의 placeholder 단서 (한국어 ≤ 20자). " +
    "예: '다른 방향을 한 줄로'. 'Recommend'/'(대안)' 같은 메타 표기는 UI 가 부착하므로 텍스트에 직접 박지 마세요.",
  "be_askUserQuestion.summaryHintDesc":
    "다중 질문 카드의 confirm 단계에서 답변 옆에 보일 row label (한국어 ≤ 10자). " +
    "예: '수정 방향', '대상 자료'. 생략 시 question 자체를 짧게 잘라 사용.",
  "be_askUserQuestion.suggestedAnswersDesc":
    "[deprecated — choices + recommendedIndex/altIndices 를 사용하세요] " +
    "구버전 호환을 위해 받지만, choices 가 있으면 무시됩니다. " +
    "신규 호출에서는 사용하지 마세요.",
};
