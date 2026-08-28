# LVIS Project Documentation

**Lvis (Local Versatile Intelligent System)**
AI 프론티어 생산성 향상 엔터프라이즈 매니지먼트 시스템

이 디렉터리는 LVIS 프로젝트 문서의 **단일 소스**입니다. 기존 standalone `lvis-project/docs` 저장소는 아카이브용 히스토리 레퍼런스만 유지합니다.

---

## 📁 목차

| 문서 | 설명 |
|------|------|
| [한국어 앱 README](./app-readme.md) | lvis-app 저장소 개요, 개발 명령, 플러그인/패키징 흐름 |
| [구현 철학](./vision/philosophy.md) | 프로젝트의 배경, 문제 인식, 철학 |
| [비전 & 골](./vision/README.md) | 프로젝트 비전, 목표, 로드맵 |
| [아키텍처](./architecture/README.md) | 아키텍처 개요와 목차 |
| [아키텍처 본문](./architecture/architecture.md) | 전체 아키텍처 상세 |
| [도구 거버넌스 보충](./architecture/tool-governance.md) | Builtin / Plugin / MCP 통합 보안 모델 |
| [플러그인 배포 모델](./architecture/plugin-deployment-model.md) | managed vs user-installed 배포 정책 상세 |
| [시작 가이드](./guides/getting-started.md) | 설치·실행, 그리고 첫 실행에서 설정 → 모델 화면의 공급자 카드로 공급자를 연결하는 절차 |
| [타일로 나뉜 채팅 그룹](../design/tiled-chat-groups.md) | 메인 영역 워크벤치 모델의 기준 문서 — 타일 단위 대화, 그룹/창 범위 구분, `lvis:chat:*` 채널 분리, 분할 트리 기하 |
| [디자인 문서 홈](../design/README.md) | 렌더러 UI 설계 문서 목록과 구현 앵커 |
| [플러그인 개발 가이드 (역사 보존)](./guides/plugin-development.md) | 과거 한국어 검토·논의 이력 — 새 작성·검증은 [현재 English guide](../guides/plugin-development.md) |
| [테마 및 UI primitive 기준](./development/theme-system.md) | semantic token theme system + shadcn registry primitive source of truth |
| [도구 로딩 정책](./development/tool-loading-policy.md) | plugin/MCP/builtin tool registry, catalog, full-schema exposure, TPM-safe loading policy |
| [레거시 sunset 정책](./development/legacy-sunset-policy.md) | migration/dormant experimental 코드 inventory, 유지 기준, 제거 PR 규칙 |
| [프로덕션 릴리스 체크리스트](./references/production-release-checklist.md) | 앱 installer 생성, signing/notarization, smoke test, publish 절차 |
| [청사진 & 이행 문서](./blueprints/) | 구현 계획, 연구 메모, 단계별 closure report |

---

## 🗂️ 저장소 구조

각 디렉터리의 주요 문서만 추립니다. 전체 목록은 해당 디렉터리를 직접 확인하세요.

```
docs/
├── README.md                              # 영문 문서 홈
├── vision/
│   ├── README.md                          # 비전, 목표, 로드맵
│   └── philosophy.md                      # 구현 철학 — 배경·문제 인식·핵심 방향
├── architecture/
│   ├── README.md                          # 아키텍처 개요·요약·목차
│   ├── architecture.md                    # ★ 현재 아키텍처
│   ├── tool-governance.md                 # 통합 도구 거버넌스 보충
│   └── plugin-deployment-model.md         # managed/user 배포 모델 상세
├── design/
│   ├── README.md                          # 렌더러 UI 설계 문서 홈·구현 앵커
│   ├── tiled-chat-groups.md               # ★ 메인 영역 워크벤치 모델 기준 문서
│   └── *.html                             # 과거 리뷰 시점의 목업 (현재 UI 기준 아님)
├── development/
│   ├── theme-system.md                    # semantic token theme + shadcn primitive 기준
│   ├── tool-loading-policy.md             # tool registry·catalog·TPM-safe 로딩 정책
│   ├── legacy-sunset-policy.md            # legacy 코드 inventory·제거 규칙
│   └── release-process.md                 # 릴리스 절차
├── references/
│   ├── production-release-checklist.md    # installer·signing·smoke·publish 절차
│   ├── plugin-signing-operations.md       # 플러그인 서명 운영
│   └── observability-guide.md             # 관측·로깅 가이드
├── guides/
│   ├── getting-started.md                 # 설치·실행·첫 실행 공급자 연결
│   ├── plugin-development.md              # 플러그인 개발 (현행 기준)
│   ├── mcp-app-authoring.md               # MCP 앱(`ui://` 카드) 작성
│   └── windows-setup.md                   # Windows 개발 환경
├── protocols/                             # 프로토콜 정의
├── research/                              # 조사 메모
├── mockups/                               # 화면 목업
├── blueprints/                            # 구현 계획·조사·단계별 closure report
└── ko/                                    # 한국어 미러 (현재 파일이 있는 곳)
```

---

## 문서 읽는 순서

1. **[구현 철학](./vision/philosophy.md)** — 배경·시장 맥락·회사 안에서의 문제 인식·사용 시나리오
2. **[비전 & 골](./vision/README.md)** — 프로젝트가 추구하는 방향과 로드맵
3. **[아키텍처](./architecture/architecture.md)** — 전체 시스템 설계 (5-Layer, LLM 중심, Electron + Rust)
4. **[도구 거버넌스 보충](./architecture/tool-governance.md)** — ToolExecutor 단일 choke point와 Builtin / Plugin / MCP 정책
5. **[시작 가이드](./guides/getting-started.md)** — 설치·실행과 첫 실행 공급자 연결

---

## 🤝 기여 방법

문서를 추가하거나 수정하려면 PR(Pull Request)을 통해 기여해 주세요.
파일은 각 디렉터리의 역할에 맞게 배치해 주시기 바랍니다.
