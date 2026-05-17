# Model Upgrade Verification — Claude / OpenAI / Gemini 모델 추가/교체 시 절차

> 새 Claude / OpenAI / Gemini 모델을 정적 카탈로그 (`src/shared/pricing-data.ts`) 또는
> 기본 모델 (`src/engine/llm/types.ts:LLM_DEFAULT_MODELS`) 에 추가/교체할 때 반드시
> 거쳐야 할 verification step. 정적 와이어링만 통과시키면 *코드는 베타 헤더를
> 보내지만 API 는 무시* 같은 silent drift 가 가능하므로 empirical 라이브 검증을
> 동반한다.

## 1. 배경 — 왜 라이브 검증이 필요한가

LVIS 는 모델별 capability (context window, 베타 헤더, 기본 thinking 모드) 를 다음 두 곳에 정적 선언한다:

1. `src/shared/pricing-data.ts` — `DEFAULT_PRICING` 에 `inputPer1M / outputPer1M / contextWindow / contextWindow1MBeta / cacheReadPer1M / cacheWritePer1M`.
2. `src/engine/llm/vercel/adapter.ts` — `contextWindow1MBeta` 가 set 된 Claude 모델에 자동으로 `anthropic-beta: context-1m-2025-08-07` 헤더 송신.

이 두 곳만 채우면 typecheck + 단위 테스트 다 통과한다. 그러나 다음 silent drift 시나리오가 가능하다:

- API 가 베타 헤더를 deprecated 처리해 무시 → 200K 컨텍스트로 잘려 답함 → 사용자는 1M 으로 믿고 큰 파일 attach → `context_length_exceeded` 에러로 실패
- 모델 id 변경 (예: `claude-sonnet-4-6` → `claude-sonnet-4-6-20251001` 처럼 date-suffix 만 인식) → 일반 호출은 404
- 베타 헤더 이름 변경 (예: `context-1m-2025-08-07` → `context-1m-2026-03-01`) → 200K fallback

실제 사례 (Sub-task #859 / 부모 #595 / 출신 PR #594): Sonnet 4.6 1M beta header 가 정적 카탈로그·adapter·default 양쪽에 들어갔으나 라이브 호출로 확인되지 않은 상태로 머지됐다. PR 시점엔 무해하지만 다음 모델 업그레이드 시 같은 절차 부재가 더 큰 drift 를 유발할 수 있다.

## 2. Verification 절차 — 모든 신규/교체 모델에 적용

### Step 1 — 정적 와이어링 추가

- `src/shared/pricing-data.ts:DEFAULT_PRICING.<vendor>` 에 모델 항목 추가
- 베타 헤더가 필요한 경우 `src/engine/llm/vercel/adapter.ts` 의 분기 (`contextWindow1MBeta` 등) 가 새 모델을 자동 catch 하는지 확인 — *벤더-스코프 분기지 모델-스코프 분기가 아니므로* 보통 추가 코드 불필요
- `src/engine/llm/types.ts:LLM_DEFAULT_MODELS` 의 기본 모델을 교체하는 경우 동시 변경

### Step 2 — 라이브 호출 검증 (필수)

벤더별 *최소 1회* 직접 호출. PR 머지 전에 PR description 에 검증 결과 (status code + 응답 한 줄) 를 명시한다.

#### Anthropic Claude

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: context-1m-2025-08-07" \
  -H "content-type: application/json" \
  -d '{"model":"<MODEL_ID>","max_tokens":50,
       "messages":[{"role":"user","content":"reply with just OK"}]}'
```

- `200 OK` + 정상 `content` ⇒ 모델 id + 베타 헤더 모두 수용. **PASS**.
- `400 invalid_request_error` + `model:` 메시지 ⇒ 모델 id 오타 또는 비공개. PR 보류.
- `400 invalid_request_error` + `beta:` 메시지 ⇒ 베타 헤더 무효 (deprecated / typo). adapter 의 베타 헤더 상수 (`CONTEXT_1M_BETA` 등) 재확인.
- `404 not_found_error` ⇒ 모델 id 비공개. PR 보류.
- `429 / 529` ⇒ rate / overload — 잠시 후 재시도. silent drift 가 아니므로 통과로 카운트하지 않는다 (재시도 후 200 받으면 PASS).

#### OpenAI / Copilot / Azure-Foundry / Vertex-AI

벤더별 형태는 다르지만 핵심은 같다: *해당 모델 id 로 minimal request 보내 200 응답을 받는다*. 베타 헤더가 없는 벤더는 헤더 검증 생략.

### Step 3 — 큰 컨텍스트 검증 (1M-tier 모델 한정)

`contextWindow1MBeta` 가 설정된 모델은 베타 헤더가 *수용* 되는 것과 *실제 1M 윈도우를 제공* 하는 것이 다를 수 있다. 다음 중 하나로 확인:

- LVIS app 실행 후 settings 에서 해당 모델 활성화 → 큰 파일 attach 로 누적 input 250K+ 도달 → stream 정상 종료 = 1M 활성. `prompt is too long` / `context_length_exceeded` 에러 = 200K fallback.
- 또는 200K+ 길이 dummy 메시지를 직접 curl 로 보내 200 응답 확인.

### Step 4 — PR description 에 결과 명시

```
## Model verification (per docs/development/model-upgrade-verification.md)

- [x] curl 검증: 200 OK, model=<MODEL_ID>, beta header accepted
- [x] 큰 컨텍스트: 280K input → normal completion (1M-tier verified live)
```

검증 결과 없는 카탈로그 변경 PR 은 review 차단.

## 3. 자동화 가능성 (현 시점 deferred)

이슈 #858 의 dynamic model catalog (models.dev style) 가 도입되면 step 1+2 의 일부가 자동화될 수 있다. 그 시점까지는 본 절차가 유일한 방어선이다. #858 reopen trigger 는 "카탈로그 PR 빈도가 분기 6+ 회 도달 또는 0/0 fallback pricing 으로 사용자 cost 표시가 0$ 되는 사례 발생" — 그 전까지는 ROI 부족으로 보류.

## 4. 관련 SoT

- `src/shared/pricing-data.ts` — pricing + context window catalog
- `src/engine/llm/vercel/adapter.ts:CONTEXT_1M_BETA` — Claude 1M beta header 상수
- `src/engine/llm/types.ts:LLM_DEFAULT_MODELS` — 벤더별 기본 모델
- 본 문서 — verification 절차
