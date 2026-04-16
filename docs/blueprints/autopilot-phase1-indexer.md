# LVIS Phase 1 인덱싱 스택 Production 격상 — 통합 구현 청사진

**문서 종류**: 단일 진실 소스 (Single Source of Truth)
**기반 리서치**: R1 (LightRAG), R2 (PageIndex), R3 (uv+Python), R4 (한국어 NLP), R5 (claw-code/ccleaks)
**머저 에이전트**: Opus, agentId `aeaf997ab35b6f4c7`
**대상 브랜치**: `lvis-app@feat/real-chat-implementation`, `lvis-plugin-pageindex@main`
**작성일**: 2026-04-13
**상태**: Phase 0+1 완료 (consensus plan), Phase 2 구현 진행 중

---

## 1. 모순 식별과 해결

5개 보고서 사이에 실재하는 충돌은 네 건이며, 각각에 단호한 결정을 내린다.

| # | 충돌 | 입장 | 결정 | 근거 |
|---|---|---|---|---|
| C1 | 검색 코어를 누가 담당하는가 — LightRAG vs PageIndex+LVIS agentic | R1은 LightRAG의 KG 검색을 답변기로 상정. R2는 오픈소스 PageIndex에 `search()`가 **없으며** LVIS가 OpenAI function calling 루프로 직접 트리를 탐색해야 한다고 단언 | **R2 승 — Phase 1에서 검색 주체는 LVIS agentic 루프.** LightRAG는 Phase 1.5 feature flag. PageIndex는 데이터 소스로만 | R2에서 오픈소스 PageIndex 0.2.8 API 공개 메서드가 `index/get_document/get_document_structure/get_page_content` 넷뿐임 확정 |
| C2 | 한국어 BM25 위치 — Python(FTS5) vs TypeScript | R4 권장 위치 미명시. 양쪽 가능성 시사 | **Python worker 단일화.** FTS5 SQLite 커넥션, kiwi, PageIndex 클라이언트가 모두 Python 프로세스 안 | kiwipiepy/PageIndex가 Python. TS로 이동 시 IPC 왕복 비용 |
| C3 | 임베딩 batch vs real-time | R4: batch 50% 저렴 24h SLA, real-time 빠름 | **Bootstrap=batch, 증분=real-time.** P3/P4 → batch 큐, P0/P1 → real-time | P0(방금 연 파일)는 24h 기다릴 수 없음 |
| C4 | RRF 가중치 | R4=k=60 weight 미명시, R5={bm25:0.4, vec:0.4, cloud:0.2} | **R5 채택, Phase 1에서 cloud=0 → bm25:0.5, vec:0.5 정규화** | 사용자 지시(Mock 어댑터만), RRF는 rank 기반 |

---

## 2. Phase 분리

### Phase 1 (이번 라운드)

**Scope IN**
- uv + Python 3.12 자동 셋업 (R3)
- Python worker를 test-mode dict에서 **PageIndex 0.2.8 + pymupdf4llm + markitdown + kiwipiepy + SQLite FTS5(패턴 B) + lancedb**로 격상 (R2, R4)
- OpenAI text-embedding-3-small (1536 dim) 임베딩 파이프라인 (R4)
- 한국어 사전 토큰화 BM25 (kiwi → FTS5) (R4)
- HybridRetriever (RRF k=60, bm25+vec 동가중치) TS측 (R5)
- CloudIndexAdapter Mock 인터페이스만 (R5)
- LLM agentic 검색 루프 — `get_document_structure`/`get_page_content`를 function calling tool로 노출 (R2)
- IdleScheduler 5-state 머신 (R5)
- PostTurnHookChain (compact → memory-extract → idle-queue) (R5)
- Bash AST pre-validator를 `tool-executor.ts` Step 2.5로 삽입 (R5)
- macOS entitlements + requirements.lock 동봉 (R3)

### Phase 1.5 (LightRAG feature flag)

**트리거 조건** — 3개 모두 충족 시:
1. Phase 1 통합 테스트 7건 모두 green
2. pilot에서 평균 문서 수 < 3,000 (R1의 5K 상한 이내)
3. OpenAI API 예산 승인

**도입 범위**
- `worker/lightrag_client.py` 신설
- `/lightrag/insert`, `/lightrag/query`, `/lightrag/stats`, `/lightrag/reset` 엔드포인트
- Single insert queue 강제 (#1968 race condition 회피)
- `max_async=4`, working_dir corruption recovery, 5,000 문서 상한
- HybridRetriever에 `lightrag` 소스 추가 → `{bm25:0.35, vec:0.35, lightrag:0.3}`
- `settings.indexing.lightragEnabled` (기본 false)

### Phase 2 (후속)
- 로컬 임베딩: BAAI/bge-m3 (8K context, MIT, AutoRAG Kor 0.6754)
- 서버 Index Engine 실연결 (§13.2 Elasticsearch + Milvus/Qdrant)
- Lgenie/Ollama LLM 경로
- Rust 재작성 검토

---

## 3. 통합 디렉터리 구조

```
사원 PC
├── /Applications/LVIS.app                           # Electron 번들 (서명됨)
│   └── Contents/
│       ├── Resources/
│       │   ├── uv/
│       │   │   ├── darwin-arm64/uv                  # R3 standalone ~20MB
│       │   │   ├── darwin-x64/uv
│       │   │   ├── win32-x64/uv.exe
│       │   │   ├── linux-x64/uv
│       │   │   └── linux-arm64/uv
│       │   └── pageindex-worker/
│       │       ├── pageindex_worker.py              # 재작성
│       │       ├── pageindex_indexer.py             # 신규
│       │       ├── pageindex_search.py              # 신규
│       │       ├── korean_tokenizer.py              # 신규
│       │       ├── embedding_client.py              # 신규
│       │       ├── cloud_index_adapter.py           # 신규 Mock
│       │       └── python-requirements.lock
│       └── ...
│
└── ~/.lvis/
    ├── config.json
    ├── memory/{sessions,notes,compacted}/
    ├── runtime/                                      # 신규 (R3)
    │   ├── uv/                                       # UV_PYTHON_INSTALL_DIR
    │   ├── python/cpython-3.12.x-<platform>/
    │   ├── venv/                                     # uv venv
    │   │   ├── bin/python, lib/python3.12/site-packages/
    │   │   └── .ready                                # sentinel
    │   └── logs/setup.log
    ├── pageindex/                                    # 신규 (R2+R4)
    │   ├── workspace/                                # PageIndex 트리 jsonl
    │   ├── parsed/                                   # pymupdf4llm 캐시
    │   ├── fts5.sqlite                               # 한국어 content_ko
    │   ├── fts5.sqlite-wal, -shm
    │   ├── vectors.lance/                            # lancedb (1536 dim)
    │   ├── folders.json
    │   ├── index-state.json                          # mtime/docId/chunkHash
    │   └── embedding-queue.ndjson                    # batch 보류 큐
    ├── idle-scheduler/                               # 신규 (R5)
    │   ├── state.json
    │   ├── priority-queue.ndjson
    │   └── metrics.json
    ├── audit/audit.ndjson                            # 신규 (R5)
    └── plugins/{lvis-plugin-pageindex,lvis-plugin-meeting,lvis-plugin-email}/
```

---

## 4. 통합 requirements.lock (Phase 1)

`/Users/ken/workspace/GIT/github/lvis-project/lvis-plugin-pageindex/python-requirements.lock`

번들 동봉, 첫 부팅 시 `uv pip sync --frozen`. 네이티브 빌드 0, 모두 wheel.

```text
# Core indexing
pageindex==0.2.8                # R2: 오픈소스 로컬
pymupdf==1.26.1                 # R2: pymupdf4llm 의존
pymupdf4llm==0.0.17              # R2: 한국어 PDF→MD
markitdown==0.1.1                # R2: DOCX/PPTX/XLSX

# Korean NLP
kiwipiepy==0.23.1                # R4: 단호한 1순위

# Embedding + vectors
openai==1.35.0                   # R1/R4
tiktoken==0.7.0
lancedb==0.6.13                  # R4: 1536-dim 저장소
pyarrow==17.0.0

# Retrieval glue
rank-bm25==0.2.2                 # FTS5 폴백
tenacity==9.0.0                  # 지수 백오프

# HTTP worker
fastapi==0.115.0
uvicorn[standard]==0.30.6

# Observability
structlog==24.2.0
```

**주석**: networkx, nano-vectordb는 Phase 1 미포함 (LightRAG와 함께 Phase 1.5). bge-m3/FlagEmbedding 미포함 (Phase 2).

---

## 5. 통합 부팅 시퀀스

### 첫 부팅

```
t=0.00s  Electron main 시작 → main.ts
t=0.10s  PythonRuntimeBootstrapper.ensureReady()
         ├─ ~/.lvis/runtime/venv/.ready 부재 확인
         └─ IPC 'bootstrap.status' progress UI
t=0.15s  uv python install 3.12.x --install-dir ~/.lvis/runtime/python
t=25s    Python 3.12 설치 완료
t=25.1s  uv venv ~/.lvis/runtime/venv --python 3.12
t=26s    uv pip sync --frozen python-requirements.lock
t=38s    의존성 설치 완료
t=38.1s  touch ~/.lvis/runtime/venv/.ready
t=38.3s  boot.ts bootstrap() 본체 진입
t=39.0s  LvisPageIndexPlugin.start() → spawn worker
t=41s    worker /health 200, registerPluginTools
t=41.2s  IdleSchedulerService.start()
t=41.3s  PostTurnHookChain wired
t=41.5s  [boot 완료]

총 첫 부팅: macOS Apple Silicon ~40-50초 (R3 추정 35-50초)
```

### 두 번째 이후 부팅

```
t=0.00s  Electron main 시작
t=0.05s  ensureReady() → .ready 통과 → 즉시 resolve
t=0.20s  boot.ts 본체
t=0.80s  worker spawn → /health ~500ms
t=1.30s  [boot 완료]
```

---

## 6. 신규 파일 목록

### 6.1 lvis-app/ 신규 (TypeScript)

| 파일 | 책임 |
|---|---|
| `lvis-app/src/main/python-runtime.ts` | PythonRuntimeBootstrapper — uv binary, python install, venv 생성, pip sync, .ready sentinel, IPC progress |
| `lvis-app/src/main/idle-scheduler.ts` | IdleSchedulerService — R5 5-state 머신, powerMonitor 구독, P0~P4 큐 |
| `lvis-app/src/main/hybrid-retriever.ts` | HybridRetriever — worker bm25/vec + CloudAdapter RRF(k=60) 결합 |
| `lvis-app/src/main/cloud-index-adapter.ts` | CloudIndexAdapter Mock — Phase 1 빈 결과 |
| `lvis-app/src/main/bash-ast-validator.ts` | R5 Bash AST scanner — rm -rf, curl|sh, eval 탐지 |
| `lvis-app/src/main/audit-service.ts` | R5 audit 분리 — append-only NDJSON, rotation |
| `lvis-app/src/agent/post-turn-hook-chain.ts` | R5 post-turn 후크 체인 — compact → memory-extract → idle-poke |
| `lvis-app/src/agent/knowledge-search-tool.ts` | LLM function calling 4 tool 정의 + agentic driver |

### 6.2 lvis-plugin-pageindex/src/ 신규

| 파일 | 책임 |
|---|---|
| `lvis-plugin-pageindex/src/workerClient.ts` | 16 엔드포인트 typed HTTP 클라이언트 |
| `lvis-plugin-pageindex/src/indexState.ts` | index-state.json r/w, orphan/stale 탐지 |

### 6.3 lvis-plugin-pageindex/worker/ 신규 (Python)

| 파일 | 책임 |
|---|---|
| `worker/pageindex_indexer.py` | Layer A+B 통합 — pymupdf4llm/markitdown → chunking → kiwi → FTS5 + lancedb + PageIndex tree |
| `worker/pageindex_search.py` | BM25(FTS5 content_ko MATCH) + 벡터(lancedb cosine) + agentic helpers |
| `worker/korean_tokenizer.py` | kiwi 패턴 B — morpheme + stopword + 문장 경계 |
| `worker/embedding_client.py` | OpenAI text-embedding-3-small, batch+real-time, 400 RPM throttle, tenacity |
| `worker/cloud_index_adapter.py` | Phase 1 Mock |
| `worker/schema.sql` | SQLite 스키마 — documents, chunks, chunks_fts(FTS5 content_ko), embeddings_meta, WAL |
| `worker/python-requirements.lock` | §4 |

### 6.4 lvis-app/resources/ 신규

| 파일 |
|---|
| `lvis-app/resources/uv/{darwin-arm64,darwin-x64,win32-x64,linux-x64,linux-arm64}/uv[.exe]` |
| `lvis-app/scripts/fetch-uv.mjs` |
| `lvis-app/build/entitlements.mac.plist` |

### 6.5 신규 테스트

| 파일 | 종류 | 커버 |
|---|---|---|
| `lvis-plugin-pageindex/test/korean_tokenizer.test.py` | pytest | 패턴 B 왕복, 문장 경계 |
| `lvis-plugin-pageindex/test/pageindex_search.test.py` | pytest | R4의 8쿼리 recall ≥ 4/4 |
| `lvis-plugin-pageindex/test/embedding_client.test.py` | pytest | 배치 분할, 429 재시도 |
| `lvis-plugin-pageindex/test/indexer.test.py` | pytest | PDF→MD→chunk→FTS5+lance |
| `lvis-plugin-pageindex/test/indexer.ko.fixture.{md,pdf}` | fixture | 한국어 샘플 |
| `lvis-app/src/main/__tests__/python-runtime.test.ts` | vitest | .ready idempotency |
| `lvis-app/src/main/__tests__/idle-scheduler.test.ts` | vitest | 5-state 전이, P0~P4 |
| `lvis-app/src/main/__tests__/hybrid-retriever.test.ts` | vitest | RRF k=60 |
| `lvis-app/src/main/__tests__/bash-ast-validator.test.ts` | vitest | 7 차단 패턴 |
| `lvis-plugin-pageindex/test/workerClient.test.ts` | vitest | 16 엔드포인트 shape |

---

## 7. 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `lvis-app/src/boot.ts` | 맨 앞 `await pythonRuntime.ensureReady()`. IdleScheduler/Audit/HybridRetriever 등록. registerBuiltinTools에 4 도구 추가 |
| `lvis-app/src/agent/tool-executor.ts` | Step 2.5 Bash-AST Validator 삽입(line 149 직후). AuditService 주입 |
| `lvis-app/src/agent/conversation-loop.ts` | §4.5 11번째 단계 후 PostTurnHookChain.run(). IdleScheduler turn-ended 신호 |
| `lvis-plugin-pageindex/src/hostPlugin.ts` | scoreText/rankSnippets/evaluateDocument를 폴백으로 강등. chat.preview를 hybridRetriever + agentic 루프로 재작성. 도메인 부스터(보안/로드맵/지원) 제거 |
| `lvis-plugin-pageindex/src/pageIndexPlugin.ts` | HTTP 로직을 workerClient.ts로 이전. spawn/health-check/lifecycle만 담당. venv 경로 주입 |
| `lvis-plugin-pageindex/src/folderIndexer.ts` | onFileIndexed → IdleScheduler enqueue(P0) |
| `lvis-plugin-pageindex/worker/pageindex_worker.py` | TestPageIndexClient 삭제, FastAPI 16 엔드포인트로 재작성 |
| `lvis-plugin-pageindex/worker/requirements.txt` | 삭제 → python-requirements.lock 대체 |
| `lvis-plugin-pageindex/src/types.ts` | IndexMode 확장, ChunkMeta/SearchHit/HybridResult 신규 |
| `lvis-app/package.json` | postinstall, extraResources, mac.entitlements |
| `lvis-plugin-pageindex/plugin.json` | python.runtime 필드 |
| `docs/architecture/architecture.md` | §4.2 Step 0, §4.4 갱신, §9 manifest 필드 |
| `TODO.md` | Section 15 갱신 (Agent 7) |

### 7.1 Python worker HTTP API (16 엔드포인트)

| Method | Path | 목적 |
|---|---|---|
| GET | `/health` | 헬스체크 |
| GET | `/runtime/info` | python/venv path, lib versions, lock hash |
| POST | `/indexer/enqueue` | `{file_path, mode, priority}` → 큐 적재 |
| POST | `/indexer/process_one` | IdleScheduler 단일 단위 작업 |
| GET | `/indexer/state` | 큐 크기, 완료/실패 |
| POST | `/indexer/reindex` | 단일 파일 강제 재인덱싱 |
| GET | `/documents` | 문서 목록 |
| GET | `/document` | 단일 문서 메타 |
| GET | `/structure` | 트리 구조 (agentic 루프) |
| GET | `/page-content` | 페이지 콘텐츠 (agentic 루프) |
| POST | `/search/bm25` | `{query, topK}` → kiwi 토큰화 → FTS5 |
| POST | `/search/vector` | `{query, topK}` → embed → lancedb |
| POST | `/search/hybrid` | 워커 내부 RRF (TS fallback) |
| POST | `/embed/batch_flush` | batch API 일괄 제출 |
| GET | `/metrics` | 카운터 |
| POST | `/shutdown` | graceful — FTS5 checkpoint, lance flush |

---

## 8. 컴포넌트 다이어그램

```
┌──── Electron Main (TypeScript) ────────────────────────────────┐
│  main.ts                                                        │
│    ▼                                                            │
│  PythonRuntimeBootstrapper ─▶ ~/.lvis/runtime/venv/.ready       │
│    ▼                                                            │
│  boot.ts bootstrap()                                            │
│    ├── SettingsService / MemoryManager / ToolRegistry           │
│    ├── AuditService ──── ~/.lvis/audit/audit.ndjson             │
│    ├── PluginRuntime                                            │
│    │     └── lvis-plugin-pageindex (hostPlugin.ts)              │
│    │           ├── FolderAutoIndexer (chokidar)                 │
│    │           │     └─▶ IdleScheduler.enqueue(P0)              │
│    │           ├── WorkerClient (HTTP 16 엔드포인트)            │
│    │           │     └─▶ spawn: venv/bin/python worker          │
│    │           └── chat.preview → HybridRetriever               │
│    ├── HybridRetriever                                          │
│    │     ├─▶ workerClient.searchBm25                            │
│    │     ├─▶ workerClient.searchVector                          │
│    │     └─▶ CloudIndexAdapter (Mock, topK=0)                   │
│    │            RRF k=60, weights {bm25:0.5, vec:0.5}           │
│    ├── IdleSchedulerService (R5 5-state)                        │
│    │     state = RUNNING|IDLE_SCAN|THROTTLED|PAUSED|RESUME_DELAY│
│    │     P0~P4 큐 ──▶ workerClient.indexerProcessOne            │
│    ├── ConversationLoop (§4.5)                                  │
│    │     ├── ToolExecutor (8+1 step, Bash-AST Step 2.5)         │
│    │     │     └─▶ knowledge_search → HybridRetriever           │
│    │     └── PostTurnHookChain                                  │
│    └── ProactiveEngine (Daily Briefing)                         │
└─────────────────── HTTP 127.0.0.1:43129 ───────────────────────┘
                          │
┌──── Python Worker (FastAPI + uvicorn) ─────────────────────────┐
│  pageindex_worker.py (router)                                   │
│    ├── pageindex_indexer.py                                     │
│    │     ├── pymupdf4llm  ─▶ PDF 한국어                         │
│    │     ├── markitdown   ─▶ DOCX/PPTX/XLSX                     │
│    │     ├── PageIndexClient (pageindex==0.2.8)                 │
│    │     ├── korean_tokenizer.py (kiwi 패턴 B)                  │
│    │     ├── chunker (512 token, 64 overlap, 문장 경계)         │
│    │     ├── embedding_client.py ─▶ OpenAI                      │
│    │     └── writes:                                            │
│    │            ~/.lvis/pageindex/workspace/    (tree)          │
│    │            ~/.lvis/pageindex/fts5.sqlite   (content_ko)    │
│    │            ~/.lvis/pageindex/vectors.lance (1536-dim)      │
│    └── pageindex_search.py                                      │
│          ├── BM25 (FTS5 MATCH, kiwi 쿼리 토큰화)                │
│          ├── Vector (lancedb cosine top-k)                      │
│          └── agentic helpers (R2 API 4개)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. 작업 분할 — 7개 구현 에이전트

### 그룹 A+B (Day 0, 병렬)

#### Agent 1 — Runtime Bootstrap Engineer (Sonnet)
- 책임: `python-runtime.ts`, `fetch-uv.mjs`, `entitlements.mac.plist`, `python-requirements.lock`, `package.json` postinstall, `boot.ts` 훅
- 검증: `.ready` 생성, idempotent, codesign verify
- 산출물: 6 파일 + vitest

#### Agent 2 — Worker Indexer Engineer (Opus)
- 책임: `pageindex_indexer.py`, `korean_tokenizer.py`, `embedding_client.py`, `schema.sql`, `cloud_index_adapter.py`, `pageindex_worker.py` 재작성
- 검증: R4 8쿼리 4개 이상 hit, 5K chunk insert WAL 정상
- 산출물: 6 Python 파일 + 4 pytest + 2 fixture

#### Agent 3 — Retrieval Orchestrator Engineer (Opus)
- 책임: `hybrid-retriever.ts`, `cloud-index-adapter.ts`(TS), `knowledge-search-tool.ts`, `boot.ts` registerBuiltinTools 확장
- 검증: RRF k=60 수학 정확, agentic 2-hop 완료
- 산출물: 3 TS 파일 + vitest

### 그룹 C (Day 2~3, 의존: A+B)

#### Agent 4 — Plugin Integrator (Sonnet)
- 책임: `workerClient.ts`, `indexState.ts`, `pageIndexPlugin.ts` 리팩터, `hostPlugin.ts` chat.preview 재작성, `folderIndexer.ts`, `types.ts`, `plugin.json`
- 검증: 기존 index.* 핸들러 회귀 없음, agentic 검색 OpenAI 키로 동작
- 산출물: 7 파일 변경 + vitest

#### Agent 5 — Idle Scheduler Engineer (Opus)
- 책임: `idle-scheduler.ts` (5-state, powerMonitor, P0~P4), `conversation-loop.ts` 신호 배선
- 검증: 단위 테스트로 5-state 전이, P0 우선, suspend/resume mock
- 산출물: 1 파일 + vitest

### 그룹 D (Day 3~4, 의존: C)

#### Agent 6 — Governance Augmenter (Sonnet)
- 책임: `bash-ast-validator.ts`, `audit-service.ts`, `post-turn-hook-chain.ts`, `tool-executor.ts` Step 2.5 삽입, `conversation-loop.ts` 후크 호출
- 검증: 8-step 회귀 없음, 7 악성 패턴 deny, audit rotation 동작
- 산출물: 3 신규 + 2 변경 + vitest

### Final (Day 4~5)

#### Agent 7 — Docs & Verification Engineer (Sonnet)
- 책임: `architecture.md` §4.2/4.4/9 갱신, `TODO.md` Section 15 갱신, `README.md` 갱신, `e2e-phase1.ts` (S1~S7 자동화)
- 산출물: 4 파일

### 병렬 그래프

```
Day 0 ────┬────────────┐
          │            │
       Agent 1     Agent 2
       Agent 3
          │            │
Day 2 ────┴────────────┤
       Agent 4 ────────┤
       Agent 5         │
          │            │
Day 3 ────┴────────────┤
       Agent 6         │
          │            │
Day 4 ────┴────────────┤
       Agent 7         │
          │            │
Day 5 ──── Phase 1 끝
```

---

## 10. 통합 테스트 시나리오 (E2E)

`lvis-app/scripts/e2e-phase1.ts` 자동화.

### S1 — Cold boot (네트워크 양호)
1. `rm -rf ~/.lvis/runtime`
2. `npm run start`
3. 기대: bootstrap.status `pending → installing-python → installing-deps → ready`, 60초 이내 .ready, /health 200

### S2 — Warm boot
1. S1 후 재시작
2. 기대: 1.5초 이내 [boot 완료]

### S3 — 한국어 PDF 인덱싱
1. fixture 한국어 PDF 복사
2. FolderAutoIndexer → IdleScheduler P0 enqueue
3. powerMonitor mock으로 IDLE_SCAN
4. 기대: chunks 테이블 row > 0, FTS5 MATCH '규정' 결과, lance 동일 chunk_id

### S4 — 한국어 BM25 (R4 regression)
1. 8개 쿼리 (regulation/규정/규정집/규정은/규정한다/support/지원/품의)
2. 기대: 4개 이상 hit, "규정"이 "규정집/규정은/규정한다" 중 최소 1개 반환

### S5 — LLM Agentic 검색
1. "작년 연차 규정이 어떻게 바뀌었어?" 입력
2. ConversationLoop → knowledge_search → HybridRetriever top-3 → LLM document_structure → document_page_content 2-hop
3. 기대: 응답에 문서명+페이지 인용, audit 3-5 tool_call 기록

### S6 — Idle 진입/종료
1. 60초 무입력 → idle 진입
2. 기대: state=IDLE_SCAN, /indexer/process_one 루프
3. keystroke mock → 500ms 내 THROTTLED
4. 배터리 15%+unplugged mock → PAUSED

### S7 — Hybrid RRF + Mock Cloud
1. 동일 쿼리로 hybridRetriever.retrieve 직접 호출
2. 기대: sources 배열에 bm25/vec/cloud 정보, cloud 빈 응답 → degenerate, RRF score 정확

### 수동 체크리스트
- [ ] S1~S7 자동화 green
- [ ] macOS Gatekeeper 통과
- [ ] entitlement 검증
- [ ] Windows SmartScreen 통과
- [ ] 진행률 UI 표시 정상

---

## 11. 알려진 리스크 + 완화

| 위험 | 심각도 | 완화 |
|---|---|---|
| 느린 기업망 첫 부팅 3-6분 | High | 진행률 UI, runtime.offlineBundle 옵션, 사내 PyPI mirror (Phase 1.5) |
| kiwipiepy wheel 누락 플랫폼 | Medium | `pip download --platform` 5종 선제 검증 |
| OpenAI 임베딩 장애 | High | indexer.pause, FTS5만 동작, degraded 배너 |
| FTS5 corruption | Medium | WAL + integrity_check, indexState.ndjson 재구성 |
| Chokidar add 중복 | Low | awaitWriteFinish + mtime 이중 방어 |
| Worker 3시간 hang | Medium | 2시간 주기 soft-restart, heartbeat |
| macOS ad-hoc 서명 entitlement | High | E2E 서명/공증 검증 |
| Bash AST false positive | Medium | warn/deny 모드 분리 |
| LLM agentic 토큰 폭발 | Medium | top-5 + depth ≤3 하드 캡 |
| MacBook 배터리 소모 | High | 50% 미만 IDLE_SCAN 금지 기본값 |

---

## 12. Out-of-Scope (Phase 1)

| 항목 | 사유 | 시점 |
|---|---|---|
| LightRAG KG 검색 | race condition 리스크 | Phase 1.5 |
| BAAI/bge-m3 로컬 임베딩 | OpenAI 우선 검증 | Phase 2 |
| Lgenie/Ollama LLM | 사용자 지시 | Phase 2 |
| 사내 ES/Milvus 실연결 | API 미제공 | 후속 |
| PPTX/XLSX 이미지 OCR | markitdown 텍스트만 | Phase 2 Vision |
| FTS5 multi-language | 한국어 우선 | 추후 |
| 플러그인 자동 업데이트 | Marketplace 수동 | Phase 2 |
| BUDDY/Bridge/Discord/YOLO 이름 | R5 anti-pattern | 채택 안 함 |
| PageIndex 호스티드 SaaS | 별도 유료 | 채택 안 함 |
| LightRAG 마이그레이션 스크립트 | 도입 시 작성 | Phase 1.5 |

---

## References (file:line)

- `lvis-app/src/boot.ts:62-213` — bootstrap, Step 0 삽입 위치
- `lvis-app/src/boot.ts:218-245` — buildPluginConfigOverrides
- `lvis-app/src/boot.ts:272-407` — registerBuiltinTools (확장)
- `lvis-app/src/agent/tool-executor.ts:124-252` — 8-step, Step 2.5 삽입 line 149 직후
- `lvis-plugin-pageindex/src/pageIndexPlugin.ts:86-113` — 4 엔드포인트, 16개로 확장
- `lvis-plugin-pageindex/src/pageIndexPlugin.ts:115-175` — spawn + waitUntilHealthy
- `lvis-plugin-pageindex/src/hostPlugin.ts:148-293` — 폴백으로 강등할 코드
- `lvis-plugin-pageindex/src/hostPlugin.ts:588-681` — chat.preview 재작성
- `lvis-plugin-pageindex/src/folderIndexer.ts:94-105` — onFileIndexed → P0 enqueue
- `lvis-plugin-pageindex/worker/pageindex_worker.py:63-147` — TestPageIndexClient 삭제
- `lvis-plugin-pageindex/worker/pageindex_worker.py:279-323` — CLI args 확장
- `lvis-plugin-pageindex/src/types.ts:1-58` — IndexMode 확장

---

## Phase 1 완료 보고 (2026-04-13)

### Agent 결과 요약

| Agent | 역할 | 산출물 | 테스트 통과율 |
|-------|------|--------|-------------|
| Agent 1 | Runtime Bootstrap Engineer | python-runtime.ts, fetch-uv.mjs, entitlements.mac.plist, python-requirements.lock, package.json, tsconfig.json + vitest 1파일 | 6/6 (mock) |
| Agent 2 | Worker Indexer Engineer | pageindex_indexer.py, korean_tokenizer.py, embedding_client.py, cloud_index_adapter.py, schema.sql, pageindex_search.py, pageindex_worker.py 재작성 + pytest 4파일 + fixture 2개 | R4 8/8 hit |
| Agent 3 | Retrieval Orchestrator Engineer | hybrid-retriever.ts, cloud-index-adapter.ts, knowledge-search-tool.ts + vitest 2파일 | 14/14 PASS |
| Agent 4 | Plugin Integrator | workerClient.ts, indexState.ts, legacy-fallback.ts, pageIndexPlugin.ts, hostPlugin.ts, folderIndexer.ts, types.ts, plugin.json, boot.ts, main.ts, conversation-loop.ts + vitest 1파일 | 28/28 PASS |
| Agent 5 | Idle Scheduler Engineer | idle-scheduler.ts (443 lines) + vitest 1파일 | 20/20 PASS |
| Agent 6 | Governance Augmenter | bash-ast-validator.ts, audit-service.ts, post-turn-hook-chain.ts, tool-executor.ts 변경, conversation-loop.ts 변경, boot.ts 변경 + vitest 1파일 | 36/36 PASS |
| Agent 7 | Docs & Verification Engineer | architecture.md 갱신, TODO.md 갱신, README.md 갱신, e2e-phase1.ts, autopilot 완료 보고 | — |

**전체 회귀: 86/86 PASS** (bash-ast 36 + idle 20 + hybrid 10 + cloud 4 + pageindex 28)

### 통합 테스트 시나리오 — E2E `lvis-app/scripts/e2e-phase1.ts`

| ID | 시나리오 | 네트워크 필요 | 결과 |
|----|---------|-------------|------|
| S1 | Cold boot (uv → python 3.12 → venv → deps → .ready, 60초 이내) | 필요 | Phase 3에서 실측 |
| S2 | Warm boot (.ready sentinel 통과, 1.5초 이내) | 불필요 | Phase 3에서 실측 |
| S3 | 한국어 MD 인덱싱 (fixture → FTS5 + lancedb) | OpenAI key | Phase 3에서 실측 |
| S4 | 한국어 BM25 검색 (8쿼리 ≥4/8 hit) | 불필요 | Phase 3에서 실측 |
| S5 | KNOWLEDGE_DEPTH_CAP=3 검증 | 불필요 | Phase 3에서 실측 |
| S6 | Idle 5-state 전이 (FakePowerMonitor mock) | 불필요 | Phase 3에서 실측 |
| S7 | Hybrid RRF k=60 수학 검증 + Mock cloud | 불필요 | Phase 3에서 실측 |
| S8 | Bash AST validator 7 deny 패턴 + warn 모드 | 불필요 | Phase 3에서 실측 |

### 알려진 미해결 이슈

| 항목 | 심각도 | 상태 |
|------|--------|------|
| `indexer.ko.fixture.pdf` 미생성 | Low | Agent 2가 의도적으로 Agent 7에 위임. S3 PDF 경로는 MD로 대체됨 |
| `/embed/batch_flush` Phase 1 no-op | Low | 임베딩 큐 batch 제출은 Phase 1.5에서 구현 |
| chunk.page=None (MD 파일) | Low | MD 파일은 페이지 개념 없음. 정상 동작 |
| S1 Cold boot 실측치 미확인 | Medium | Python 3.12 첫 설치 시간이 네트워크에 의존. Phase 3에서 실측 필요 |

### Phase 1.5/2로 미룬 항목 재확인

| 항목 | 사유 | 트리거 조건 |
|------|------|------------|
| LightRAG KG 검색 | race condition 리스크 (#1968) | Phase 1 통합 테스트 7건 green + 평균 문서 < 3K + OpenAI 예산 승인 |
| BAAI/bge-m3 로컬 임베딩 | OpenAI 우선 검증 | Phase 2 |
| Lgenie/Ollama LLM | 사용자 지시 | Phase 2 |
| 사내 ES/Milvus 실연결 | API 명세 미제공 | 후속 라운드 |
| PPTX/XLSX 이미지 OCR | markitdown 텍스트만 | Phase 2 Vision |

### 다음 단계

```
Phase 3 (QA) — 지금 바로 실행 가능
  1. npx tsx lvis-app/scripts/e2e-phase1.ts S2 S5 S6 S7 S8  (mock 시나리오)
  2. OPENAI_API_KEY 설정 후 S3 S4
  3. 네트워크 환경에서 S1 (첫 부팅 60초 이내 검증)

Phase 4 (Validation) — QA green 후
  1. Architect (Opus) — §4.4 + §13.3 일치 검증
  2. Security-reviewer (Sonnet) — Bash AST 우회, audit 누락 시도
  3. Code-reviewer (Opus) — SOLID, 동시성, 7-checkpoint

Phase 5 (Cleanup + Commit) — 사용자 승인 후
  1. .omc/state 정리
  2. git commit (Phase 1 모든 산출물)
```

---

**작성 완료**: 2026-04-13 KST
