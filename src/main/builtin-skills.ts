/**
 * Built-in skills shipped inline with the host. Distinct from user-authored
 * skills under `~/.lvis/skills/`. Bundled as TS so the build pipeline does
 * not need to copy markdown into `dist/`.
 *
 * Each entry is rendered through {@link parseFrontmatter} the same way a
 * user file would be, so the contract stays consistent.
 *
 * Target audience: staff-organization users (총무 · 회계 · 인사 · 기획 · 법무 ·
 * 구매 등). Skills cover everyday office tasks — reports, meeting minutes,
 * email tone, decision records, data summaries — not software development.
 */
import type { LoadedSkill } from "./skill-store.js";

export const BUILTIN_SKILLS: LoadedSkill[] = [
  {
    name: "report-writing",
    description:
      "Structured business-report writing skill — situation, action, result, recommendation",
    triggers: ["report", "리포트", "보고서", "summary", "결산"],
    source: "builtin",
    filePath: "<builtin>:report-writing",
    body: `# Report Writing Skill

When the user asks for a business-style report or summary, structure your
response with the four-part SARR template:

1. **Situation** — Set the context in 1–2 sentences. What happened, who was
   involved, and over what window?
2. **Action** — List the concrete steps that were taken (or that are being
   recommended), bullet-pointed for scannability.
3. **Result** — Quantify the outcome where possible. Pull metrics from any
   tools you called (web_search, document_search, task_list). Be honest about
   gaps in the data.
4. **Recommendation** — Close with the one or two next steps the reader
   should take. Keep these actionable, not aspirational.

Format guidelines:
- Use Markdown headings for each of the four sections.
- Lead each bullet with a strong verb.
- Length budget: 200–400 words for a standard daily report.
- If the underlying data is thin, say so explicitly under "Result" rather
  than padding with filler.`,
  },
  {
    name: "meeting-minutes",
    description:
      "회의록 정리 skill — 일시·참석자·논의·결정·할일 5섹션 표준 형식",
    triggers: ["meeting", "회의록", "회의", "minutes", "안건", "결정사항"],
    source: "builtin",
    filePath: "<builtin>:meeting-minutes",
    body: `# Meeting Minutes Skill

사용자가 회의 메모 · transcript · 음성 요약을 던지며 "회의록으로 정리" 를
요청하면 다음 5섹션 표준 형식으로 출력하세요.

## 표준 형식

### 1. 일시 · 장소
- 일시: \`YYYY-MM-DD HH:MM ~ HH:MM (KST)\`
- 장소 / 매체: 회의실명 또는 Teams / Zoom / 대면+원격

### 2. 참석자
- 호스트: 이름 (소속/직책)
- 참석: 이름 1, 이름 2, ...
- 결석 (사전 양해): 이름 + 사유 (있을 때만)

### 3. 논의
- **안건 1**: 한 줄 요약 + 주요 의견 2–3 개
- **안건 2**: ...

### 4. 결정 (Decisions)
- ✅ [결정 내용] — 결정 근거 / 누가 책임

### 5. 할일 (Action Items)
| # | 할일 | 담당 | 기한 | 비고 |
|---|---|---|---|---|
| 1 | ... | 이름 | 2026-MM-DD | ... |

## 작업 원칙

- 사용자가 *제공한 정보만* 사용. 누락된 칸은 \`(확인 필요)\` 로 명시.
- "결정" 과 "논의" 구분: 합의 도달 → 결정, 미합의 → 논의 + follow-up 필요.
- 할일은 *담당 · 기한* 모두 있어야 진짜 할일. 둘 중 하나 없으면 \`(확인 필요)\`.
- 발언 순서 그대로 옮기지 말고 *주제별로 묶어* 정리.
- 민감 정보 (인사평가, 연봉, 미공개 인사) 가 보이면 본문에 그대로 적지 말고
  "민감 사안 — 별도 확인" 표기.

## 길이 / 톤

- 1 시간 회의 → A4 1 페이지 안 (300~500 단어).
- 객관 사실 위주, 형용사 최소화.
- 마지막 줄에 현재 한국시간 \`YYYY-MM-DD HH:MM KST\` 표기.`,
  },
  {
    name: "email-polish",
    description:
      "메일·공문 톤 정리 skill — 받는 사람·목적·요청·서명 4부 구조로 다듬기",
    triggers: ["email", "메일", "공문", "polish", "다듬", "톤", "초안"],
    source: "builtin",
    filePath: "<builtin>:email-polish",
    body: `# Email Polish Skill

사용자가 메일·공문 초안 또는 거친 메모를 던지며 "정리/다듬어 줘" 를 요청
하면 4부 구조로 출력하세요.

## 4부 구조

1. **받는 사람 / 인사** — "OO 부장님, 안녕하세요." 또는 "관계자 여러분께,"
2. **목적** (1 문장) — "이번 메일은 ~ 알려 드리고자 합니다." / "~ 요청 드립니다."
3. **본문** — 3 문단 이내. 한 문단 한 주제.
4. **요청 / 마무리** — 구체 요청 (회신 기한 · 첨부 회신 · 일정 확정 등) + 서명.

## 톤 선택

| 톤 | 사용 시점 | 종결형 |
|---|---|---|
| Formal | 사외 / 임원 / 공문 | -니다 / 드립니다 / 부탁드립니다 |
| Semi-formal | 사내 부서간 / 동등 직급 | -요 / 합니다 / 드리겠습니다 |
| Casual | 같은 팀 / 친밀 관계 | -해요 / 부탁해요 |

사용자가 톤 명시 안 했으면 *Semi-formal* 기본. 받는 사람 정보 (직급 · 소속)
보고 격상/격하.

## 작업 원칙

- 사용자가 *전달하려는 핵심* 을 본문 첫 문단 첫 줄에 둠 (역피라미드).
- 부정 표현 (못합니다, 안 됩니다) 보다 *대안 제시* (~ 으로 도와드릴 수 있습니다).
- 첨부가 있으면 본문에 "첨부: 파일명 (간단 설명)" 명시.
- 회신 기한이 필요한 메일은 *마지막 문단* 에 "회신 기한: YYYY-MM-DD" 별도 줄.
- 외부 발신 시 회사명 · 직책 · 연락처 서명 포함.
- 톤 다듬은 후 *원본 키 정보 모두 보존* — 임의 추가 · 삭제 금지. 변경한 부분은
  결과 아래 \`## 변경 포인트\` 로 짧게 요약.

## 출력 형식

\`\`\`
## 정리본
[받는 사람]
[제목 — 명확하고 액션 가능]

[본문 4부]

[서명]

## 변경 포인트
- 톤: [casual → semi-formal] 등
- 추가 정보: [회신 기한 명시 등]
- 누락 보강 필요: [확인 필요 항목]
\`\`\`

마지막 줄에 현재 한국시간 \`YYYY-MM-DD HH:MM KST\` 표기.`,
  },
  {
    name: "decision-record",
    description:
      "의사결정 기록 skill — 배경·대안·선택·근거·책임 5섹션 영구 보관용",
    triggers: ["decision", "의사결정", "결정", "ADR", "선택", "검토"],
    source: "builtin",
    filePath: "<builtin>:decision-record",
    body: `# Decision Record Skill

사용자가 "OO 을 정했어, 기록해 줘" 또는 "OO 결정 정리" 를 요청하면 영구
보관 가능한 5섹션 구조로 출력하세요. (Architecture Decision Record 의 사무직
응용 — 회의록 보다 *오래 살아남는* 의사결정 기록.)

## 표준 형식

### 1. 결정 (한 문장)
\`[2026-MM-DD] [주제]: [결정 내용]\` — 제목 한 줄로 검색 가능하게.

### 2. 배경 / 문제
- 왜 이 결정이 필요했는지 (1–3 문단)
- 누가 제안했는지 / 언제부터 논의됐는지
- 결정하지 않으면 어떤 위험이 있는지

### 3. 검토한 대안
| 대안 | 장점 | 단점 | 선택? |
|---|---|---|---|
| 안 A | ... | ... | ✅ 선택 |
| 안 B | ... | ... | ❌ |
| 안 C | ... | ... | ❌ |

### 4. 선택 근거
- 가장 결정적인 이유 1–3 개 (예: 예산 한도, 일정, 조직 정합성)
- 정량 비교 가능하면 숫자 인용

### 5. 책임 / 후속
- **승인자**: 이름 (직책) — 2026-MM-DD 승인
- **실행 책임**: 이름 (직책)
- **후속 점검**: 2026-MM-DD 까지 [확인할 것]
- **재검토 트리거**: [상황 X 발생 시 / N 개월 후]

## 작업 원칙

- *결정 시점 사실* 만 기록. 이후 변경된 상황은 *새 결정 기록* 으로 별도 작성.
- 미합의 사안은 결정 기록 아님 — 회의록 / 안건 으로 분류.
- 익명화 금지: 책임 소재가 핵심. 단 민감 사안은 직책 명시 + 이름 \`(내부 보관)\`.
- 출력은 *그대로 파일 저장* 가능한 형태 (예: \`decisions/2026-05-23-신규제도.md\`).

## 출력 형식

위 5섹션을 markdown 으로 그대로 출력. 끝에:

\`\`\`
---
이 기록 파일명 제안: \`decisions/YYYY-MM-DD-<keyword>.md\`
저장 위치 제안: 사내 공유 드라이브 / Confluence / OneDrive 의 의사결정 폴더
\`\`\`

마지막 줄에 현재 한국시간 \`YYYY-MM-DD HH:MM KST\` 표기.`,
  },
  {
    name: "data-summary",
    description:
      "표·csv 데이터 요약 skill — 핵심 지표·이상치·트렌드를 액션 가능한 형태로",
    triggers: ["summary", "요약", "data", "데이터", "통계", "표", "csv"],
    source: "builtin",
    filePath: "<builtin>:data-summary",
    body: `# Data Summary Skill

사용자가 표 · csv · 엑셀 데이터를 던지며 "요약" / "분석" / "핵심만 뽑아 줘"
를 요청하면 다음 형식으로 출력하세요.

## 표준 형식

### 1. 한눈에
- 행 수 / 컬럼 수 / 기간
- **핵심 숫자 3 개** — 사용자가 첫 30 초에 알아야 할 것 (총합 · 평균 · 변화율)

### 2. 핵심 지표
| 지표 | 값 | 비고 |
|---|---|---|
| 총합 | ... | 단위 명시 |
| 평균 | ... | ... |
| 중앙값 | ... | 평균과 차이 크면 분포 왜곡 신호 |
| 최댓값 | ... | 행/카테고리 식별 |
| 최솟값 | ... | 행/카테고리 식별 |

### 3. 이상치 · 주의
- [평균 ±2σ 벗어난 값] — 행/항목 식별 + 가능한 이유 추측 (확인 필요)
- [빈 셀 · 의심 데이터] — N 개, 컬럼 X 에서 발견
- [중복 의심] — 같은 키 N 행 발견 시

### 4. 트렌드
- 시계열이면 *방향* (상승 / 하락 / 횡보) 과 *변동성* (안정 / 진폭 큼)
- 카테고리면 *상위 3 / 하위 3* 만
- 단순 묘사 NO — "왜 그럴 수 있는지" 1 줄 추측 (단, "확인 필요" 명시)

### 5. 다음 액션 제안
- 사용자가 *이 요약을 보고 다음에 할 일* 1–3 개
- 예: "X 부서 매출 급감 — 담당자에게 원인 확인 요청", "결측치 보강 후 재집계"

## 작업 원칙

- **숫자 정확** > 풍부한 해석. 한 자리 틀리면 보고서 전체 신뢰 손상.
- 단위 항상 명시 (\`원\`, \`%\`, \`건\`, \`명\`). 통화 단위는 \`KRW\` / \`USD\` 같이 분리.
- 추측은 *추측 표시*: "~ 가능성 있음 (확인 필요)" — 단정 금지.
- *그 표만 보고 알 수 있는 것* 과 *추가 정보가 필요한 것* 을 분리.
- 사용자가 *원본 표를 줬으면* 그대로 인용. 임의 변형 / 정렬 금지.
- 시각화 (그래프) 가 더 적합한 경우 "이 데이터는 [선형 그래프 / 막대 / 파이]
  로 보면 더 직관적" 한 줄 제안 — 직접 그리진 말고 추천만.

## 민감 / 한계

- 개인정보 (이름 · 사번 · 연봉 · 인사평가) 컬럼이 포함되어 있으면 본문에 *값
  그대로 인용 X*. 컬럼 존재 사실 · 통계만 보고하고 개별 행은 식별 정보 가림.
- 표본이 작은 경우 (N < 30 등) "표본 크기 작음 — 일반화 주의" 명시.
- 마지막 줄에 현재 한국시간 \`YYYY-MM-DD HH:MM KST\` 표기.`,
  },
];
