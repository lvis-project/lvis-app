# LVIS Project Documentation

**Lvis (LG Virtual Intelligence Secretary)**
AI 프론티어 생산성 향상 엔터프라이즈 매니지먼트 시스템

이 디렉터리는 LVIS 프로젝트 문서의 **단일 소스**입니다. 기존 standalone `lvis-project/docs` 저장소는 아카이브용 히스토리 레퍼런스만 유지합니다.

---

## 📁 목차

| 문서 | 설명 |
|------|------|
| [구현 철학](./vision/philosophy.md) | 프로젝트의 배경, 문제 인식, 철학 |
| [비전 & 골](./vision/README.md) | 프로젝트 비전, 목표, 로드맵 |
| [아키텍처](./architecture/README.md) | **LVIS Architecture v0.4.1 Draft** — 5-Layer, 42+ Mermaid 다이어그램 |
| [아키텍처 본문](./architecture/architecture.md) | 전체 아키텍처 상세 (16개 섹션, 38+ 서브섹션) |
| [도구 거버넌스 보충](./architecture/tool-governance.md) | Builtin / Plugin / MCP 통합 보안 모델 |
| [플러그인 배포 모델](./architecture/plugin-deployment-model.md) | managed vs user-installed 배포 정책 상세 |
| [실행 가이드](./guides/getting-started.md) | 프로그램 설치 및 실행 방법 |
| [플러그인 개발 가이드](./guides/plugin-development.md) | plugin.json, HostApi, UI 슬롯, 배포 흐름 |
| [프로덕션 릴리스 체크리스트](./references/production-release-checklist.md) | 앱 installer 생성, signing/notarization, smoke test, publish 절차 |
| [청사진 & 이행 문서](./blueprints/) | 구현 계획, 연구 메모, 단계별 closure report |

---

## 🗂️ 저장소 구조

```
docs/
├── README.md                              # 문서 저장소 홈 (현재 파일)
├── vision/
│   ├── README.md                          # 비전, 목표, 로드맵
│   └── philosophy.md                      # 구현 철학 — 배경·문제 인식·핵심 방향
├── architecture/
│   ├── README.md                          # 아키텍처 개요·요약·목차
│   ├── architecture.md                    # ★ 현재 아키텍처 (v0.4.1 Draft)
│   ├── tool-governance.md                 # 통합 도구 거버넌스 보충
│   ├── plugin-deployment-model.md         # managed/user 배포 모델 상세
│   └── architecture.reference.md          # v1 초안 (참고용)
├── guides/
│   ├── getting-started.md                 # 시작 및 실행 가이드
│   └── plugin-development.md              # 플러그인 개발 가이드
└── blueprints/                            # 구현 계획·조사·closure report
```

---

## 문서 읽는 순서

1. **[구현 철학](./vision/philosophy.md)** — 배경·시장 맥락·회사 안에서의 문제 인식·사용 시나리오
2. **[비전 & 골](./vision/README.md)** — 프로젝트가 추구하는 방향과 로드맵
3. **[아키텍처](./architecture/architecture.md)** — 전체 시스템 설계 (5-Layer, Lgenie 중심, Electron + Rust)
4. **[도구 거버넌스 보충](./architecture/tool-governance.md)** — ToolExecutor 단일 choke point와 Builtin / Plugin / MCP 정책
5. **[실행 가이드](./guides/getting-started.md)** — 설치 및 실행 방법

---

## 🤝 기여 방법

문서를 추가하거나 수정하려면 PR(Pull Request)을 통해 기여해 주세요.
파일은 각 디렉터리의 역할에 맞게 배치해 주시기 바랍니다.
