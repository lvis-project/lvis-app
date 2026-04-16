# 시작 가이드 (Getting Started)

Lvis를 로컬 환경에서 설치하고 실행하는 방법을 안내합니다.  
Lvis는 **설치형 에이전트 플랫폼**으로, 개인 컴퓨터에 상주하며 업무를 처리합니다.

> 이 가이드는 현재 초안(draft) 상태입니다. 프로젝트가 진행됨에 따라 구체적인 내용이 채워집니다.

---

## Lvis가 해결하는 문제

Lvis를 설치하면 다음과 같은 상황에서 도움을 받을 수 있습니다:

- 출장 품의, 비행기 예약, 숙소 예약 등 **반복적인 업무 절차**
- 소프트웨어 도입·결재 등 **사내 프로세스 탐색**
- 조직 업무 파악 및 **보고서 작성 지원**
- 다른 팀 담당자 연결 등 **사내 네트워크 탐색**

---

## 시스템 아키텍처

LVIS의 전체 아키텍처는 [architecture.md](../architecture/architecture.md)에서 확인할 수 있습니다.
5-Layer Architecture(사용자·단말 → 클라이언트 인텔리전스 → 실행·추론 → 연동 → 거버넌스) 기반으로 설계되었으며, Electron + Rust(NAPI-RS) 클라이언트와 Lgenie(사내 LLM) 서버로 구성됩니다.

---

## 사전 요구사항 (Prerequisites)

아래 도구들이 설치되어 있어야 합니다.

- Electron 런타임 환경 (추후 버전 확정)
- Rust toolchain (NAPI-RS 빌드용)
- Python 3.x (PageIndex 인덱싱 엔진)
- 사내 네트워크 접근 (Lgenie 연동 — 온라인 전제)

---

## 설치 (Installation)

```bash
# 저장소 클론
git clone https://github.com/lvis-project/<repository>.git
cd <repository>

# 의존성 설치
# (추후 업데이트 예정)
```

---

## 실행 (Running)

```bash
# Lvis Personal Agent 실행
# (추후 업데이트 예정)
```

---

## LGenie 연동 설정

Lvis는 **LGenie(사내 LLM 시스템)** 와 SSE(Server-Sent Events) 기반 스트리밍 세션을 맺어 채팅·요약·계획 등 추론을 수행합니다.
상세 스트리밍 아키텍처는 [architecture.md §4.5.3](../architecture/architecture.md)을 참조하세요.

```bash
# LGenie 연동 설정
# (추후 업데이트 예정)
```

---

## 환경 변수 (Environment Variables)

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `LGENIE_API_URL` | LGenie API 엔드포인트 | (추후 추가) |
| `LGENIE_API_KEY` | LGenie 인증 키 | (추후 추가) |
| `AGENT_MEMORY_PATH` | 로컬 기억 저장 경로 | `~/.lvis/memory` |

---

## 빌드 (Build)

```bash
# 프로덕션 빌드
# (추후 업데이트 예정)
```

---

## 테스트 (Testing)

```bash
# 테스트 실행
# (추후 업데이트 예정)
```

---

## 문제 해결 (Troubleshooting)

자주 발생하는 문제와 해결 방법을 정리합니다.

> (추후 업데이트 예정)

---

## 관련 문서

- [구현 철학](../vision/philosophy.md)
- [아키텍처](../architecture/architecture.md)
- [비전 & 골](../vision/README.md)
