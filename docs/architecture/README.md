# 아키텍처 (Architecture)

LVIS 프로젝트의 **시스템 구조 및 기술 설계** 문서입니다.
프로젝트의 철학적 배경은 [구현 철학](../vision/philosophy.md)을 참고하세요.

이 디렉터리는 LVIS 아키텍처 문서의 canonical 홈입니다. standalone `lvis-project/docs` 저장소는 아카이브용 reference만 유지합니다.

---

## 문서 구성

| 문서 | 설명 |
|------|------|
| **[architecture.md](./architecture.md)** | **최종 아키텍처 (v4 Final)** — 5-Layer Architecture, 42+ Mermaid 다이어그램, 16개 섹션 |
| [tool-governance.md](./tool-governance.md) | §6.3 / §9.5 / §14.2 보충 — 통합 도구 거버넌스 |
| [plugin-deployment-model.md](./plugin-deployment-model.md) | managed vs user-installed 플러그인 배포 모델 상세 |
| [architecture.reference.md](./architecture.reference.md) | v1 초안 (참고용 보존) |

---

## 아키텍처 요약

> _"직원은 판단과 소통에 집중하고, 절차·탐색·정리는 Lvis·LGenie가 맡는 회사."_

### 5-Layer Architecture

| Layer | 이름 | 핵심 역할 |
|-------|------|-----------|
| **L1** | 사용자·단말 | Electron UI + Plugin Slots |
| **L2** | 클라이언트 인텔리전스 | 키워드 감지, 에이전트 라우팅, 인덱싱, 기억, Proactive |
| **L3** | 실행·추론 | Lgenie(사내 LLM) 세션 + Agent Loop + Tool 실행 |
| **L4** | 연동 | Agent Hub, Marketplace, 서버 인덱스, 사내 시스템 |
| **L5** | 거버넌스 | 인증, 정책, 감사, 암호화 |

### 핵심 컴포넌트

```
┌─────────────────────────────────────────────────────┐
│              LVIS Agent Platform (Electron)          │
│                                                     │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ Chat UI      │  │ Daily       │  │ Plugin     │ │
│  │ + Streaming  │  │ Briefing    │  │ Slots      │ │
│  └──────┬───────┘  └──────┬──────┘  └─────┬──────┘ │
│         │                 │               │         │
│  ┌──────┴─────────────────┴───────────────┴──────┐  │
│  │         Rust Native Engines (NAPI-RS)         │  │
│  │  KW Engine · Route Engine · Index Engine      │  │
│  │  Tool Permission · Tool Executor · Hooks      │  │
│  └──────────────────────┬────────────────────────┘  │
│                         │                           │
│  ┌──────────────────────┴────────────────────────┐  │
│  │  Memory (LVIS.md · notes/) · SQLite · PageIndex│  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │ SSE Streaming
              ┌───────┴───────┐
              │  Lgenie (심장) │
              │  사내 LLM 시스템│
              └───────┬───────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   Agent Hub    Marketplace    Governance
   (메시지보드)  (플러그인스토어) (정책·감사)
```

### 상세 문서 목차 (architecture.md)

1. Design Philosophy — 철학에서 구조로
2. High-Level Design (HLD) — System Overview · Five Pillars
3. System Layer Map — 5-Layer Architecture
4. Low-Level Design (LLD) — Client · Boot · Agent Loop · Local Index · **Conversation Query Loop**
5. Memory — 경량 기억 구조
6. Client Core Engines — KW Engine · Route Engine · **Tool Permission** · **Tool Taxonomy** · **Command Safety**
7. Proactive Engine — Daily Briefing
8. Agent Approval System — 에이전트 승인 체계
9. Plugin System — UI Extension · **MCP Protocol Architecture**
10. Agent Hub — 사원 레플리카 메시지 보드
11. Marketplace Hub — 사업부 플러그인 생태계
12. Use Case → Architecture Mapping
13. Data Flow
14. Deployment & Governance — Topology · Stack · **Feature Flag & Gradual Rollout**
15. Appendix

### Technology Stack

| 분류 | 기술 |
|------|------|
| Client | Electron + React, Rust (NAPI-RS), SQLite + FTS5 |
| Indexing | PageIndex (LLM 트리 인덱싱), Doc Parser (PDF·DOCX·PPTX·XLSX·Image) |
| Server | Lgenie (사내 LLM), Agent Hub (Go/Rust + PostgreSQL + NATS), Marketplace |
| Protocol | SSE Streaming, gRPC/REST, MCP (stdio/SSE/WebSocket) |
| Governance | SSO/LDAP, OPA Policy Engine, AES-256 + TLS 1.3, Feature Flag Service |

---

## 관련 문서

- [구현 철학](../vision/philosophy.md)
- [비전 & 골](../vision/README.md)
- [실행 가이드](../guides/getting-started.md)
- [플러그인 개발 가이드](../guides/plugin-development.md)
