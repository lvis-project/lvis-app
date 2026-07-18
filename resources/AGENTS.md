# LVIS — Agent / LLM Reference

이 문서는 LVIS 호스트 안에서 동작하는 LLM (메인 채팅 어시스턴트, 플러그인
도구 호출 LLM, sub-agent, routine 실행자 등) 이 시스템을 올바르게 사용하기
위한 **single source of truth** 다. 첫 부팅 시 LVIS 호스트가 packaged 자원
으로부터 이 파일을 `~/.lvis/AGENTS.md` 에 seed 한다. 사용자가 직접 편집해
도 안전하다 — 다음 LVIS 업그레이드는 `~/.lvis/AGENTS.md.new` 로 새 버전
을 옆에 두어 사용자가 diff/merge 할 수 있도록 한다.

LVIS 는 **Electron host + plugin marketplace** 아키텍처다. 사용자 데이터는
`~/.lvis/` 하위에만 저장한다. 플러그인은 *manifest + HostApi self-
registration* 패턴으로 호스트와 결합한다.

---

## 0. 작업 시작 전 First Principles

1. **확신 없으면 이 문서 + host API spec 부터 read** — 추측 금지. 특히
   디렉토리 위치, 설정 파일 경로, suffix 의미.
2. **3-strikes-out 룰**: 같은 카테고리 도구로 3회 연속 zero-relevance 결과
   → 즉시 다른 카테고리로 전환. 같은 도구 28-step 헤매기 = 가장 비싼 실패
   모드.
3. **사설 정보는 public search index 부재** — LVIS 내부 자원 (플러그인,
   설정, 마켓 데이터) 은 WebSearch 결과가 무관. 도구 선택의 첫 step 은
   *도메인 인식*: public domain 인가, LVIS private 인가?
4. **추측한 경로/파일/명령은 실행 전에 1회 verify** — `ls` 또는 `stat` 으로
   존재 확인 후 read/write. 부재한 path 를 그대로 쓰면 root 에 흩어지는
   anti-pattern 발생.

---

## 1. Storage Namespace — `~/.lvis/<feature>/`

모든 사용자 데이터는 *도메인 디렉토리* 안에 둔다. root 에 도메인 specific
파일이 흩어지면 안 된다.

```
~/.lvis/
├── AGENTS.md                  # 이 문서 — 항상 첫 read 대상
├── settings.json              # cross-cutting 호스트 설정
├── audit.log                  # cross-cutting 감사 로그
├── permissions.json           # 권한/정책 메모리
├── secrets/                   # 암호화 비밀 (cross-cutting)
├── sessions/                  # 메인 채팅 세션
│   └── <sessionId>.jsonl
├── routine/                   # routine v2
│   ├── routines.json
│   └── sessions/<routineId>/<firedAt>.jsonl
├── mcp/                       # MCP 카탈로그 + 설치된 서버
│   ├── servers.json           # ← MCP 설정의 정답 위치
│   └── <slug>/                # 설치된 MCP 서버별 디렉토리
├── plugins/<pluginId>/        # 플러그인 namespace
│   ├── data.json
│   └── auth-partitions.json
└── ...
```

### 룰

- **단일 도메인 = 단일 디렉토리**. 같은 도메인의 설정/세션/캐시/상태 모두
  그 디렉토리 하위에 모은다.
- **파일 권한**: 디렉토리 `0o700`, 파일 `0o600`. `secrets/` 는 추가 암호화
  의무.
- **Cross-cutting 자원만 root 직속** (`settings.json`, `audit.log`,
  `secrets/`, `permissions.json`). 도메인 specific 자원이 root 에 흩어지
  면 위반이다.
- **플러그인** 은 `~/.lvis/plugins/<pluginId>/` 만 사용한다. 다른 도메인
  (`~/.lvis/sessions/`, `~/.lvis/routine/` 등) 을 직접 read/write 하면 안
  된다 — HostApi 를 통해서만 접근한다.

### 위반 ❌ → 정답 ✅

| 위반 패턴 | 정답 |
|---|---|
| `~/.lvis/mcp-servers.json` (root 흩어짐) | `~/.lvis/mcp/servers.json` |
| `~/.lvis/routines.json` (root 흩어짐) | `~/.lvis/routine/routines.json` |
| `~/.lvis/<plugin>-data.json` | `~/.lvis/plugins/<plugin>/data.json` |
| plugin 이 host 의 `~/.lvis/sessions/` 직접 read | `hostApi.getSession(id)` |
| 새 feature 추가 시 root 에 새 파일 만들기 | `~/.lvis/<new-feature>/` 디렉토리 신설 |

---

## 2. File Suffix Conventions

LVIS 는 파일 이름 끝의 suffix 로 *의미* 를 표현한다. 빈 파일이라도 suffix
가 있으면 의미가 있다.

| Suffix | 의미 | 헷갈리기 쉬운 점 |
|--------|------|------------------|
| `*.guard` | 보안/권한/정책 enforcement marker. 비어 있어도 *enabled* 신호. | "비었으니까 설정 없음" 이라고 추론하지 말 것. 설정 파일은 같은 도메인의 별도 위치. |
| `*.lock` | 동시성 lock 파일. 보유 프로세스만 release 할 권리. | 함부로 지우면 안 됨 — 어떤 프로세스가 들고 있는지 확인 우선. |
| `*.disabled/` | 부팅 시 신뢰 보류된 hook/plugin 디렉토리. Hook v1 TOFU 룰 — 사용자가 `/permission hooks accept <name>` 으로 명시 승인해야 활성화. | renderer 에서 fallback prompt/modal 만들지 말 것. |
| `*.sig` | 서명 메타데이터 (예: `marketplace-whitelist.e2e.json.sig`). | 본 파일과 짝. 본 파일만 수정하고 서명 안 갱신하면 검증 실패. |
| `*.jsonl` | JSON Lines — append-only 트랜스크립트. | 중간 row 수정 금지 — 새 row append 만. |
| `*.new` | 패키지 업그레이드 신호 (예: `AGENTS.md.new`). | 사용자 검토 대상. 자동 머지 금지. |

---

## 3. Information Source Hierarchy

LVIS *사설* 자산 정보는 공개 검색 엔진에 인덱스되어 있지 않다. 도구 선택
순서:

| 정보 유형 | 1순위 source | 2순위 source | ❌ 사용 금지 |
|---|---|---|---|
| 마켓플레이스 플러그인 최신 버전 | `curl https://marketplace.lvisai.xyz/api/v1/plugins/<slug>` | repo git tag | WebSearch |
| 설치된 플러그인 버전 | `cat ~/.lvis/plugins/<slug>/plugin.json \| jq .version` | — | WebSearch |
| MCP 서버 카탈로그 | `cat ~/.lvis/mcp/servers.json` | — | WebSearch |
| 설치된 MCP 서버 디렉토리 | `ls ~/.lvis/mcp/` | — | WebSearch |
| 호스트 LVIS 버전 | `cat <appPath>/package.json \| jq .version` | git tag | WebSearch |
| 호스트 설정 | `cat ~/.lvis/settings.json` | — | WebSearch |
| LVIS 내부 이슈/PR (개발용) | `gh -R lvis-project/<repo> pr list` | — | WebSearch |
| 공개 라이브러리 / API 레퍼런스 | WebSearch + 공식 문서 | — | — |

**핵심 원칙**: 공개 검색 엔진 = 공개 인덱스 가정. 사설/내부/on-machine 정보
는 인덱스 부재 → 무한 재시도해도 결과 없음.

---

## 4. MCP Integration

LVIS 는 Model Context Protocol 서버를 마켓플레이스에서 설치/관리한다.

### 카탈로그 파일

- **위치**: `~/.lvis/mcp/servers.json`
- **형식**:
  ```json
  {
    "servers": {
      "<slug>": {
        "command": "...",
        "args": ["..."],
        "env": { "KEY": "value" },
        "connectionTimeoutMs": 30000
      }
    }
  }
  ```
- 새 MCP 서버 추가 시 이 파일을 수정한다. **root 에 따로 만들지 말 것**
  (예: `~/.lvis/mcp-servers.json` ❌).
- `~/.lvis/mcp/` 가 없으면 먼저 `mkdir -p ~/.lvis/mcp` 후 생성.

### 설치된 서버

각 MCP 서버는 `~/.lvis/mcp/<slug>/` 디렉토리를 갖는다. 서버 자체 자산
(binaries, manifest 등) 이 여기에 저장된다.

### 보안 ceiling

- `mcpRequestMaxMs = 120_000` — 호스트 cap. server 가 더 큰 connectionTimeoutMs 를 보내도 ingestion 단에서 reject.
- SSE absolute deadline — streaming activity reset 으로 cap 우회 불가.

---

## 5. Plugin Model

플러그인은 *manifest + HostApi self-registration* 패턴으로 호스트와 결합
한다. **호스트 코드는 플러그인 specific 코드를 갖지 않는다** — 모든 통합
은 HostApi 를 통한다.

### Manifest 위치

- 마켓 설치: `~/.lvis/plugins/<pluginId>/plugin.json`
- 개발 모드: `lvis-plugin-<name>/plugin.json` (repo 안)

### Three Naming Namespaces (no runtime conversion)

| 형식 | 예시 | 사용 위치 |
|------|------|----------|
| Plugin ID | `com.example.meeting-recorder` 또는 `foo-bar` | manifest `id`, 디렉토리 이름 |
| LLM tool name | `foo_bar_open` | underscore only, `^[a-zA-Z0-9_-]+$` 만족 |
| Plugin event name | `${manifest.id}.<verb>.<noun>` | 리터럴 manifest id, `_` ↔ `-` 변환 없음 |

**중요**: 세 namespace 간 자동 변환 없음. 작성한 형식 그대로 사용. 예를
들어 manifest id 가 `foo-bar` (dash) 이면 event 는 `foo-bar.auth.changed`
이지 `foo_bar.auth.changed` (tool-prefix 미러링) 가 아니다.

### HostApi self-registration 메서드

플러그인 부팅 시 다음 API 로 호스트에 등록:

- `registerKeywords()` — KeywordEngine 스킬 키워드
- `registerToolSchemas()` — LLM tool 등록 (manifest 의 `toolSchemas`)
- `emitEvent()` / `onEvent()` — pub/sub 이벤트
- `addTask()`, `saveNote()` — 호스트 데이터 진입 (sessions/notes)
- `getSecret()` — 암호화 비밀 read

### Tool category 선언 (manifest 필수)

플러그인 manifest 의 `toolSchemas[*].category` 는 다음 중 하나:

- `read` — filesystem read / API read
- `write` — filesystem write / API mutation
- `shell` — shell 명령 실행
- `network` — 외부 네트워크 호출

`meta` 는 host builtin 전용 — plugin manifest 에서 금지.

---

## 6. Tool Execution Timeouts

모든 tool 호출 timeout 의 single source of truth: `src/shared/tool-timeout-policy.ts`. 직접 hardcode 금지.

| 정책 | 값 | 의미 |
|------|----|------|
| `shellMaxMs` | 120_000 | 일반 shell tool 최대 |
| `globalCeilingMs` | 120_000 | tool executor 글로벌 ceiling |
| `mcpRequestMaxMs` | 120_000 | MCP request 최대 |
| `mcpRequestDefaultMs` | 30_000 | MCP request 기본 |
| `subAgentCeilingMs` | 600_000 | **예외** — sub-agent inner loop 만 |
| `approvalGateUserWaitMs` | 300_000 | 사용자 입력 대기 (cap 대상 아님) |

LLM 이 long-running shell (`bun install` 등) 으로 판단하면 `timeoutSeconds`
input 으로 최대 `shellMaxMs / 1000 = 120` 까지 명시 가능.

---

## 7. Permission Model

LVIS 권한 시스템 single source of truth:
- `docs/architecture/permission-policy-design.md`
- `docs/architecture/architecture.md` §6.3

### Source-aware 권한

| Source | 신뢰도 | 권한 부여 방법 |
|--------|--------|----------------|
| `user-keyboard` | 최고 | `/permission` slash command 직접 입력 |
| `tool-arg` | 중 | LLM 이 결정. 매번 modal 검토 가능. |
| `plugin-overlay` / `file-content` | 낮음 | slash 무력화 — plain text 로 sanitize |

### Mutating tool 룰

- write / shell / network 카테고리 tool 은 reviewer layer 를 먼저 통과
  해야 함
- HIGH severity 는 deferred queue 로 보내고 사용자 승인 후 실행
- headless / routine 실행이 reviewer 우회 금지

---

## 8. Loop Escape Clause

**3 attempt rule**: 같은 카테고리 도구로 3회 연속 zero-relevance 결과 →
즉시 다른 카테고리로 전환.

예시:
- WebSearch 3회 무관 결과 → `gh` CLI / marketplace API / 로컬 파일 read
- File grep 3회 zero match → 다른 디렉토리 / LSP tool / sourcemap
- Manifest 위치 추측 3회 → AGENTS.md §1 (디렉토리 트리) 다시 read

**비싼 실패 모드 사례 (실제)**: agent 가 `lvis-plugin-agent-hub` 최신 버전
을 찾으려고 WebSearch 28회 반복 → 무관 결과만 반환 → 결국 답 없이 종료.
정답은 marketplace API 1회 호출. 도메인 인식 + 3-strikes 가 이 패턴을
방지한다.

---

## 9. Common Failure Modes

이 표는 *실제로 자주 발생하는* 헷갈림 패턴이다. 추측 전에 검토.

| 증상 | 진짜 원인 | 정답 |
|------|----------|------|
| `mcp-servers.json.guard` 만 보고 "설정 없음" 추론 | `.guard` suffix 의미 모름 (§2) | guard = enforcement marker. 설정은 `~/.lvis/mcp/servers.json` |
| MCP 설정 만들 때 `~/.lvis/mcp-servers.json` (root) 에 생성 | Storage namespace 룰 모름 (§1) | `~/.lvis/mcp/servers.json` (도메인 디렉토리 안) |
| 플러그인 최신 버전 알려면 Google 검색 | 사설 인덱스 부재 모름 (§3) | marketplace API curl 1회 |
| WebSearch 3+ 회 무관 결과인데 계속 retry | Loop escape clause 모름 (§8) | 즉시 다른 도구 카테고리 |
| Plugin 이 host directory 직접 read 시도 | HostApi self-registration 모름 (§5) | HostApi 통한 access (`hostApi.getSession(id)` 등) |
| Tool timeout 600s 직접 hardcode | timeout SOT 모름 (§6) | `tool-timeout-policy.ts` import |
| `auth-partitions.json` 을 `~/.lvis/` root 에 두려 함 | plugin namespace 룰 (§1) | `~/.lvis/plugins/<id>/auth-partitions.json` |
| Event name 을 underscore 로 변환 (`foo_bar.auth.changed`) | three-namespace 룰 (§5) | manifest id 그대로 (`foo-bar.auth.changed`) |
| `*.disabled/` 디렉토리를 active 라고 가정 | Hook v1 TOFU 룰 (§2) | 사용자가 `/permission hooks accept <name>` 으로 명시 승인해야 활성 |
| 외부 task (날씨, 뉴스 등) 끼어들어 핵심 task drift | task focus 부재 | 사용자 요청 task 외 sidequest 금지. 명시 안 된 정보 fetch X |

---

## 10. Quick Reference Cheatsheet

| 자주 묻는 질문 | 답 |
|---|---|
| MCP 서버 어디 설정? | `~/.lvis/mcp/servers.json` |
| 채팅 세션 어디 저장? | `~/.lvis/sessions/<sessionId>.jsonl` |
| 플러그인 데이터 어디? | `~/.lvis/plugins/<pluginId>/` |
| 호스트 설정 어디? | `~/.lvis/settings.json` |
| 권한 메모리 어디? | `~/.lvis/permissions.json` |
| 감사 로그 어디? | `~/.lvis/audit.log` |
| 새 도메인 추가하면? | `~/.lvis/<new-domain>/` 디렉토리 신설 (root 파일 X) |
| 마켓 플러그인 버전 어떻게? | `curl https://marketplace.lvisai.xyz/api/v1/plugins/<slug>` |
| Timeout 변경하려면? | `src/shared/tool-timeout-policy.ts` SOT 만 수정 |

---

## 11. Further Reading

- `lvis-app/docs/architecture/architecture.md` — v4 Final 아키텍처
- `lvis-app/docs/architecture/permission-policy-design.md` — 권한 모델
- `lvis-app/CLAUDE.md` — 개발자용 룰 (이 문서의 상위)

위 문서들은 LVIS 소스 트리 안에 있으며 packaged 앱에는 포함되지 않을 수
있다. 호스트 안의 LLM 은 이 `AGENTS.md` 만으로 동작할 수 있어야 한다.

---

## Versioning

이 문서는 LVIS 앱과 함께 ship 된다. 새 LVIS 버전이 이 문서를 갱신하면 다
음 부팅 시 `~/.lvis/AGENTS.md.new` 로 새 버전을 옆에 둔다. 사용자가 diff
하여 본인의 `AGENTS.md` 에 merge 한 후 `.new` 파일을 지우면 된다.

Last updated: 이 파일은 LVIS 빌드 시 함께 갱신된다 — git history 참조.
