# LVIS Architecture Document

> **Version**: 0.1.0-draft  
> **Date**: 2026-04-11  
> **Status**: Architecture Draft  
> **Authors**: LVIS Architecture Team

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [High-Level Design (HLD)](#2-high-level-design-hld)
3. [System Layer Map](#3-system-layer-map)
4. [Low-Level Design (LLD)](#4-low-level-design-lld)
5. [Client Core Engines](#5-client-core-engines)
6. [Plugin System & UI Extension](#6-plugin-system--ui-extension)
7. [Agent Hub](#7-agent-hub)
8. [Marketplace Hub](#8-marketplace-hub)
9. [Data Flow](#9-data-flow)
10. [Deployment Topology](#10-deployment-topology)

---

## 1. Design Philosophy

LVIS의 설계 철학은 세 가지 원칙에 기반한다.

**Local-First Intelligence** — 대부분의 업무를 로컬에서 처리한다. 사용자 PC에 설치된 클라이언트가 로컬 문서 인덱싱, 키워드 감지, 에이전트 라우팅을 자체적으로 수행한다. 서버는 로컬이 할 수 없는 일(LLM 추론, 전사적 동기화)만 담당한다.

**Employee Replica Network** — 전 사원이 자신의 디지털 레플리카(에이전트)를 갖는다. 이 에이전트들은 메시지 보드를 통해 서로 소통하며, 사원이 부재 중에도 비동기적으로 협업할 수 있는 통로가 된다.

**Dynamic Extensibility** — 클라이언트는 최소한의 코어로 시작하여, 플러그인을 통해 기능과 UI를 동적으로 확장한다. 플러그인은 부팅 시 자동 업데이트되며, Electron 클라이언트의 렌더러를 직접 변경할 수 있다.

---

## 2. High-Level Design (HLD)

### 2.1 System Overview

```mermaid
graph TB
    subgraph "👤 Employee Desktop"
        CLIENT["LVIS Client<br/>(Electron)"]
        LOCAL_IDX["Local Index Engine<br/>(문서/파일 인덱싱)"]
        LOCAL_STORE["Local Knowledge Store<br/>(SQLite + Vector DB)"]
    end

    subgraph "🏢 Enterprise Infrastructure"
        subgraph "Core Services"
            LGENIE["Lgenie<br/>(사내 LLM System)"]
            AUTH["Auth & Identity<br/>(SSO/LDAP)"]
        end

        subgraph "Agent Hub"
            MSG_BOARD["Message Board<br/>(Agent 간 통신)"]
            AGENT_REG["Agent Registry<br/>(전 사원 레플리카)"]
            AGENT_RT["Agent Runtime<br/>(비동기 실행)"]
        end

        subgraph "Marketplace Hub"
            PLUGIN_STORE["Plugin Store<br/>(사업부 플러그인)"]
            API_GW["API Gateway<br/>(사업부 API 연동)"]
            PLUGIN_SPEC["Plugin Spec Registry<br/>(구축 스펙)"]
        end

        subgraph "Server Index"
            SRV_IDX["Server Index Engine<br/>(전사 문서 인덱싱)"]
            SRV_STORE["Enterprise Knowledge Store"]
        end
    end

    CLIENT <-->|"WebSocket/gRPC"| LGENIE
    CLIENT <-->|"REST API"| MSG_BOARD
    CLIENT <-->|"REST API"| PLUGIN_STORE
    CLIENT -->|"Query"| SRV_IDX
    CLIENT --- LOCAL_IDX
    LOCAL_IDX --- LOCAL_STORE
    MSG_BOARD --- AGENT_REG
    MSG_BOARD --- AGENT_RT
    AGENT_RT <-->|"LLM 추론"| LGENIE
    API_GW <-->|"사업부 시스템"| PLUGIN_SPEC
    SRV_IDX --- SRV_STORE
    AUTH -.->|"인증"| CLIENT
    AUTH -.->|"인증"| MSG_BOARD
    AUTH -.->|"인증"| API_GW
```

### 2.2 HLD Layer Summary

```mermaid
block-beta
    columns 1
    block:LAYER1["Layer 1: Presentation — LVIS Electron Client"]
        A1["Chat UI"] A2["Plugin UI Slots"] A3["File Explorer"] A4["Memory Vault"]
    end
    block:LAYER2["Layer 2: Client Core — Intelligence Engines"]
        B1["Keyword<br/>Detecting<br/>Engine"] B2["Agent<br/>Route<br/>Engine"] B3["Local Index<br/>Engine"] B4["Plugin<br/>Lifecycle<br/>Manager"]
    end
    block:LAYER3["Layer 3: Communication — Protocol Layer"]
        C1["Lgenie<br/>Session"] C2["Agent Hub<br/>MessageBus"] C3["Marketplace<br/>API Client"] C4["Sync<br/>Engine"]
    end
    block:LAYER4["Layer 4: Server — Enterprise Services"]
        D1["Lgenie<br/>LLM"] D2["Agent Hub<br/>Board"] D3["Marketplace<br/>Hub"] D4["Server Index<br/>& Knowledge"]
    end

    LAYER1 --> LAYER2
    LAYER2 --> LAYER3
    LAYER3 --> LAYER4
```

### 2.3 Four Pillars Architecture

```mermaid
graph LR
    subgraph PILLAR1["🖥️ LVIS Client"]
        direction TB
        P1A["Electron Shell"]
        P1B["Core Engines"]
        P1C["Plugin Host"]
        P1D["Local Store"]
        P1A --> P1B --> P1C --> P1D
    end

    subgraph PILLAR2["🤖 Agent Hub"]
        direction TB
        P2A["Message Board"]
        P2B["Agent Registry"]
        P2C["Replica Runtime"]
        P2D["Async Mailbox"]
        P2A --> P2B --> P2C --> P2D
    end

    subgraph PILLAR3["🏪 Marketplace Hub"]
        direction TB
        P3A["Plugin Store"]
        P3B["API Gateway"]
        P3C["Spec Registry"]
        P3D["BU Connectors"]
        P3A --> P3B --> P3C --> P3D
    end

    subgraph PILLAR4["🧠 Lgenie"]
        direction TB
        P4A["LLM Inference"]
        P4B["Model Router"]
        P4C["Context Manager"]
        P4D["Token Accounting"]
        P4A --> P4B --> P4C --> P4D
    end

    PILLAR1 <--> PILLAR2
    PILLAR1 <--> PILLAR3
    PILLAR1 <--> PILLAR4
    PILLAR2 <--> PILLAR4
```

---

## 3. System Layer Map

시스템은 4개의 명확한 레이어로 구성된다. 각 레이어는 하위 레이어에만 의존하며, 상위 레이어를 직접 참조하지 않는다.

```mermaid
graph TB
    subgraph "Layer 1 — Presentation"
        direction LR
        L1_CHAT["💬 Chat Interface"]
        L1_PLUGIN_UI["🧩 Plugin UI Slots"]
        L1_FILE["📁 File Explorer"]
        L1_MEM["🧠 Memory Vault"]
        L1_NOTIFY["🔔 Notification Center"]
    end

    subgraph "Layer 2 — Client Intelligence"
        direction LR
        L2_KW["Keyword Detecting Engine"]
        L2_ROUTE["Agent Route Engine"]
        L2_IDX["Local Index Engine"]
        L2_PLUGIN["Plugin Lifecycle Manager"]
        L2_SKILL["Skill Registry"]
    end

    subgraph "Layer 3 — Communication"
        direction LR
        L3_SESSION["Lgenie Session Manager"]
        L3_MSGBUS["Agent Hub MessageBus"]
        L3_MARKET["Marketplace API Client"]
        L3_SYNC["Bi-directional Sync"]
    end

    subgraph "Layer 4 — Enterprise Server"
        direction LR
        L4_LLM["Lgenie LLM System"]
        L4_AGENT["Agent Hub Server"]
        L4_MARKET["Marketplace Server"]
        L4_INDEX["Server Index Engine"]
    end

    L1_CHAT --> L2_KW
    L1_CHAT --> L2_ROUTE
    L1_PLUGIN_UI --> L2_PLUGIN
    L1_FILE --> L2_IDX
    L1_MEM --> L2_IDX

    L2_KW --> L3_SESSION
    L2_ROUTE --> L3_MSGBUS
    L2_ROUTE --> L3_SESSION
    L2_PLUGIN --> L3_MARKET
    L2_IDX --> L3_SYNC
    L2_SKILL --> L3_SESSION

    L3_SESSION --> L4_LLM
    L3_MSGBUS --> L4_AGENT
    L3_MARKET --> L4_MARKET
    L3_SYNC --> L4_INDEX
```

---

## 4. Low-Level Design (LLD)

### 4.1 Client Architecture (Electron)

LVIS 클라이언트는 Electron 기반이며, claw-code 하네스에서 영감받은 에이전트 루프를 내장한다.

```mermaid
graph TB
    subgraph "Electron Main Process"
        BOOT["Boot Sequence"]
        CONFIG["Config Loader"]
        PLUGIN_MGR["Plugin Manager"]
        IPC["IPC Bridge"]
        LOCAL_DB["Local DB<br/>(SQLite)"]
        VEC_DB["Vector Store<br/>(Local Embedding)"]
        
        BOOT --> CONFIG
        CONFIG --> PLUGIN_MGR
        BOOT --> IPC
    end

    subgraph "Electron Renderer Process"
        SHELL["App Shell"]
        CHAT_VIEW["Chat View"]
        PLUGIN_SLOTS["Dynamic Plugin Slots"]
        FILE_VIEW["File Explorer View"]
        MEM_VIEW["Memory Vault View"]
        
        SHELL --> CHAT_VIEW
        SHELL --> PLUGIN_SLOTS
        SHELL --> FILE_VIEW
        SHELL --> MEM_VIEW
    end

    subgraph "Client Core (Native Module)"
        KW_ENGINE["Keyword Detecting Engine"]
        ROUTE_ENGINE["Agent Route Engine"]
        IDX_ENGINE["Local Index Engine"]
        TOOL_EXEC["Tool Executor"]
        PERMISSION["Permission Manager"]
        HOOK_RUNNER["Hook Runner"]
        
        KW_ENGINE --> ROUTE_ENGINE
        ROUTE_ENGINE --> TOOL_EXEC
        TOOL_EXEC --> HOOK_RUNNER
        PERMISSION --> TOOL_EXEC
    end

    IPC <--> SHELL
    IPC <--> KW_ENGINE
    PLUGIN_MGR --> PLUGIN_SLOTS
    IDX_ENGINE --> LOCAL_DB
    IDX_ENGINE --> VEC_DB
```

### 4.2 Boot Sequence

클라이언트 부팅 시 스킬과 에이전트가 동적으로 업데이트된다.

```mermaid
sequenceDiagram
    participant App as LVIS Client
    participant Config as Config Loader
    participant Auth as Auth Service
    participant PluginMgr as Plugin Manager
    participant Market as Marketplace Hub
    participant AgentHub as Agent Hub
    participant Lgenie as Lgenie

    App->>Config: 1. Load local config
    Config->>Auth: 2. SSO/LDAP 인증
    Auth-->>Config: Token 발급

    par Dynamic Update
        Config->>Market: 3a. Fetch plugin manifest
        Market-->>PluginMgr: Plugin list + versions
        PluginMgr->>PluginMgr: Diff & install/update plugins
    and
        Config->>AgentHub: 3b. Fetch skill/agent registry
        AgentHub-->>App: Updated skills & agent configs
    and
        Config->>Lgenie: 3c. Session handshake
        Lgenie-->>App: Session ID + model config
    end

    PluginMgr->>App: 4. Register plugin UI slots
    App->>App: 5. Initialize Core Engines
    App->>App: 6. Start Local Index Engine
    App->>App: 7. Ready — Render UI
```

### 4.3 Agent Loop (claw-code Harness 기반)

사용자의 입력이 처리되는 핵심 루프. claw-code의 `ConversationRuntime.run_turn()` 패턴을 차용하되, LVIS의 키워드 감지와 에이전트 라우팅을 앞단에 추가한다.

```mermaid
flowchart TB
    INPUT["사용자 입력<br/>(채팅 메시지)"]
    
    KW{"Keyword<br/>Detecting<br/>Engine"}
    
    CLASSIFY{"입력 분류"}
    
    SKILL_INVOKE["Skill Invocation<br/>(회의록, 번역 등)"]
    AGENT_ROUTE["Agent Route Engine<br/>(에이전트 선택)"]
    DIRECT_LLM["Lgenie 직접 대화"]
    
    TOOL_LOOP["Tool Execution Loop"]
    
    PRE_HOOK["PreToolUse Hook<br/>(Plugin hooks)"]
    PERM{"Permission<br/>Check"}
    EXEC["Tool Execute"]
    POST_HOOK["PostToolUse Hook"]
    
    RESULT["Tool Result"]
    LLM_CALL["Lgenie 추론 요청"]
    RESPONSE["응답 생성"]
    
    RENDER["UI 렌더링<br/>(Chat / Plugin UI)"]
    
    INPUT --> KW
    KW --> CLASSIFY
    
    CLASSIFY -->|"스킬 키워드 감지"| SKILL_INVOKE
    CLASSIFY -->|"에이전트 라우팅 필요"| AGENT_ROUTE
    CLASSIFY -->|"일반 대화"| DIRECT_LLM
    
    SKILL_INVOKE --> TOOL_LOOP
    AGENT_ROUTE --> TOOL_LOOP
    DIRECT_LLM --> LLM_CALL
    
    TOOL_LOOP --> PRE_HOOK
    PRE_HOOK --> PERM
    PERM -->|"허용"| EXEC
    PERM -->|"거부"| RESPONSE
    EXEC --> POST_HOOK
    POST_HOOK --> RESULT
    RESULT --> LLM_CALL
    
    LLM_CALL --> RESPONSE
    RESPONSE -->|"추가 Tool 호출 필요"| TOOL_LOOP
    RESPONSE -->|"완료"| RENDER
```

### 4.4 Local Index Engine

로컬 PC의 데이터를 최대한 활용하는 핵심 엔진.

```mermaid
graph LR
    subgraph "Data Sources"
        LOCAL_FILES["로컬 파일<br/>(문서, 이미지, 코드)"]
        SERVER_DOCS["서버 문서<br/>(권한 기반 동기화)"]
        CHAT_HISTORY["대화 이력"]
        MEMORY["기억 저장소"]
    end

    subgraph "Index Pipeline"
        WATCHER["File Watcher<br/>(inotify/FSEvents)"]
        PARSER["Document Parser<br/>(PDF, DOCX, HWP, ...)"]
        CHUNKER["Chunker<br/>(Semantic Split)"]
        EMBEDDER["Local Embedder<br/>(경량 모델)"]
    end

    subgraph "Storage"
        SQLITE["SQLite<br/>(메타데이터 + FTS5)"]
        VECTOR["Vector DB<br/>(HNSW Index)"]
        CACHE["Query Cache<br/>(LRU)"]
    end

    subgraph "Query Interface"
        SEMANTIC["Semantic Search"]
        KEYWORD["Keyword Search"]
        HYBRID["Hybrid Ranker<br/>(RRF)"]
    end

    LOCAL_FILES --> WATCHER
    SERVER_DOCS --> WATCHER
    CHAT_HISTORY --> PARSER
    MEMORY --> PARSER

    WATCHER --> PARSER
    PARSER --> CHUNKER
    CHUNKER --> EMBEDDER
    EMBEDDER --> VECTOR
    CHUNKER --> SQLITE

    SEMANTIC --> VECTOR
    KEYWORD --> SQLITE
    SEMANTIC --> HYBRID
    KEYWORD --> HYBRID
    HYBRID --> CACHE
```

---

## 5. Client Core Engines

### 5.1 Keyword Detecting Engine

사용자 입력에서 의도와 컨텍스트를 감지하는 첫 번째 관문. claw-code의 `SlashCommand::parse()` + `resolve_skill_invocation()` 패턴을 확장한다.

```mermaid
flowchart LR
    INPUT["Raw Input"] --> TOKENIZER["Tokenizer"]
    
    TOKENIZER --> CMD_DETECT{"명령어 감지<br/>/command"}
    TOKENIZER --> SKILL_DETECT{"스킬 키워드<br/>회의록, 번역, ..."}
    TOKENIZER --> INTENT_DETECT{"의도 분류<br/>질문/요청/지시"}
    TOKENIZER --> ENTITY_EXTRACT["엔티티 추출<br/>@사람, #채널, 파일명"]
    
    CMD_DETECT -->|"매칭"| CMD_EXEC["Command Executor"]
    SKILL_DETECT -->|"매칭"| SKILL_RESOLVE["Skill Resolver"]
    INTENT_DETECT --> ROUTE_HINT["Route Hint"]
    ENTITY_EXTRACT --> CONTEXT_ENRICH["Context Enrichment"]
    
    ROUTE_HINT --> ROUTE_ENGINE["Agent Route Engine"]
    CONTEXT_ENRICH --> ROUTE_ENGINE
    SKILL_RESOLVE --> ROUTE_ENGINE
```

**동작 방식:**

| 우선순위 | 감지 유형 | 예시 | 처리 방식 |
|---------|----------|------|----------|
| 1 | 명시적 명령어 | `/meeting start` | Command Executor 직접 실행 |
| 2 | 스킬 키워드 | "회의록 작성해줘" | Skill Resolver → 해당 플러그인 활성화 |
| 3 | 에이전트 멘션 | "@김철수 이거 확인해줘" | Agent Hub 메시지 라우팅 |
| 4 | 의도 기반 | "이 문서 요약해줘" | Intent → Route Engine → Lgenie |
| 5 | 일반 대화 | "안녕하세요" | Lgenie 직접 세션 |

### 5.2 Agent Route Engine

감지된 의도를 올바른 실행 경로로 전달하는 라우터. claw-code의 `CliToolExecutor` 디스패치 패턴을 채용한다.

```mermaid
flowchart TB
    ROUTE_INPUT["Route Request<br/>(intent + context + entities)"]
    
    ROUTE_INPUT --> RESOLVER{"Route Resolver"}
    
    RESOLVER -->|"로컬 스킬"| LOCAL_SKILL["Local Skill Executor<br/>(플러그인 내장 기능)"]
    RESOLVER -->|"원격 에이전트"| AGENT_HUB_ROUTE["Agent Hub Router<br/>(메시지 보드 전달)"]
    RESOLVER -->|"LLM 대화"| LGENIE_SESSION["Lgenie Session<br/>(직접 추론)"]
    RESOLVER -->|"복합 작업"| ORCHESTRATOR["Task Orchestrator<br/>(다중 스킬 조합)"]
    RESOLVER -->|"마켓플레이스 API"| MARKET_CALL["Marketplace API Call<br/>(사업부 API)"]
    
    LOCAL_SKILL --> RESULT["Execution Result"]
    AGENT_HUB_ROUTE --> RESULT
    LGENIE_SESSION --> RESULT
    ORCHESTRATOR --> RESULT
    MARKET_CALL --> RESULT
    
    RESULT --> RENDERER["Response Renderer<br/>(Chat or Plugin UI)"]
```

**Route Resolution 우선순위:**

```
1. Permission Check      → 권한이 없으면 즉시 거부
2. Local Skill Match     → 설치된 플러그인에서 스킬 매칭 시도
3. Agent Hub Routing     → @멘션 또는 에이전트 위임이 필요한 경우
4. Marketplace API       → 사업부 API 호출이 필요한 경우
5. Lgenie Fallback       → 위 모두 해당 없으면 LLM 직접 대화
```

---

## 6. Plugin System & UI Extension

### 6.1 Plugin Architecture

플러그인은 LVIS 클라이언트의 핵심 확장 메커니즘이다. Electron 렌더러의 UI를 동적으로 변경할 수 있으며, 새로운 스킬과 도구를 등록한다.

```mermaid
graph TB
    subgraph "Plugin Package (.lvis-plugin)"
        MANIFEST["manifest.json<br/>(메타데이터, 의존성, 권한)"]
        SKILLS["skills/<br/>(스킬 정의 YAML/JSON)"]
        UI_COMP["ui/<br/>(React 컴포넌트)"]
        TOOLS["tools/<br/>(도구 실행 스크립트)"]
        HOOKS["hooks/<br/>(PreToolUse, PostToolUse)"]
        ASSETS["assets/<br/>(아이콘, 리소스)"]
    end

    subgraph "Plugin Lifecycle"
        DISCOVER["Discover<br/>(부팅 시 Marketplace 조회)"]
        DOWNLOAD["Download<br/>(버전 비교 후 다운로드)"]
        VALIDATE["Validate<br/>(서명 검증, 권한 확인)"]
        INSTALL["Install<br/>(파일 배치, 의존성 해결)"]
        ACTIVATE["Activate<br/>(스킬 등록, UI 마운트)"]
        
        DISCOVER --> DOWNLOAD --> VALIDATE --> INSTALL --> ACTIVATE
    end

    subgraph "Runtime Integration"
        SKILL_REG["Skill Registry 등록"]
        TOOL_REG["Tool Registry 등록"]
        UI_MOUNT["UI Slot 마운트"]
        HOOK_REG["Hook Runner 등록"]
        KW_REG["Keyword Registry 등록"]
    end

    ACTIVATE --> SKILL_REG
    ACTIVATE --> TOOL_REG
    ACTIVATE --> UI_MOUNT
    ACTIVATE --> HOOK_REG
    ACTIVATE --> KW_REG
    
    SKILLS --> SKILL_REG
    TOOLS --> TOOL_REG
    UI_COMP --> UI_MOUNT
    HOOKS --> HOOK_REG
    MANIFEST --> KW_REG
```

### 6.2 Plugin Manifest Spec

```json
{
  "id": "com.lge.meeting-recorder",
  "name": "회의록 녹음",
  "version": "1.2.0",
  "description": "STT 기반 회의록 자동 작성 플러그인",
  "author": "DX Platform Team",
  "permissions": [
    "microphone",
    "local-storage",
    "lgenie-session",
    "ui-slot:sidebar",
    "ui-slot:toolbar"
  ],
  "keywords": ["회의록", "녹음", "회의", "미팅", "meeting"],
  "skills": [
    {
      "name": "meeting-record",
      "trigger": ["회의록 작성", "회의 녹음", "미팅 기록"],
      "entry": "skills/meeting-record.js"
    }
  ],
  "tools": [
    {
      "name": "stt-transcribe",
      "entry": "tools/stt.js",
      "description": "음성을 텍스트로 변환"
    }
  ],
  "ui": {
    "sidebar": "ui/MeetingSidebar.jsx",
    "toolbar": "ui/MeetingToolbar.jsx",
    "chatWidget": "ui/MeetingChatWidget.jsx"
  },
  "hooks": {
    "PreToolUse": "hooks/pre-meeting.js",
    "PostToolUse": "hooks/post-meeting.js"
  },
  "dependencies": {
    "translation-plugin": ">=1.0.0"
  },
  "lgenie": {
    "requiredModels": ["stt-whisper", "summary-v2"],
    "optionalModels": ["translation-nmt"]
  }
}
```

### 6.3 UI Slot System

Electron 클라이언트는 플러그인이 UI를 주입할 수 있는 사전 정의된 슬롯을 제공한다.

```mermaid
graph TB
    subgraph "LVIS Client UI Layout"
        subgraph "Title Bar"
            TOOLBAR_SLOT["🧩 Toolbar Slot"]
        end
        
        subgraph "Main Area"
            direction LR
            subgraph "Sidebar"
                SIDEBAR_SLOT["🧩 Sidebar Slot"]
                NAV["Navigation"]
            end
            subgraph "Content"
                CHAT_AREA["💬 Chat Area"]
                CHAT_WIDGET_SLOT["🧩 Chat Widget Slot"]
            end
            subgraph "Right Panel"
                PANEL_SLOT["🧩 Panel Slot"]
            end
        end

        subgraph "Bottom"
            STATUS_SLOT["🧩 Status Bar Slot"]
        end
    end

    subgraph "Plugin UI Mount"
        MEETING_TOOLBAR["MeetingToolbar.jsx<br/>→ Toolbar Slot"]
        MEETING_SIDEBAR["MeetingSidebar.jsx<br/>→ Sidebar Slot"]
        MEETING_WIDGET["MeetingChatWidget.jsx<br/>→ Chat Widget Slot"]
    end

    MEETING_TOOLBAR -.-> TOOLBAR_SLOT
    MEETING_SIDEBAR -.-> SIDEBAR_SLOT
    MEETING_WIDGET -.-> CHAT_WIDGET_SLOT
```

### 6.4 Plugin Example: 회의록 녹음 플러그인

설치 전과 후의 클라이언트 상태 변화를 보여주는 시나리오:

```mermaid
stateDiagram-v2
    state "기본 클라이언트" as BASE {
        [*] --> Chat: 부팅
        Chat --> Lgenie: 메시지 전송
        Lgenie --> Chat: 응답
        Chat --> FileExplorer: 파일 탐색
        Chat --> MemoryVault: 기억 조회
    }

    state "회의록 플러그인 설치 후" as WITH_PLUGIN {
        [*] --> Chat2: 부팅 + 플러그인 로드
        Chat2 --> KeywordDetect: "회의록 작성해줘"
        KeywordDetect --> MeetingMode: 스킬 키워드 매칭
        
        state MeetingMode {
            [*] --> Recording: STT 시작
            Recording --> Transcribing: 실시간 변환
            Transcribing --> MidSummary: 중간 요약
            MidSummary --> Recording: 계속 녹음
            MidSummary --> FinalSummary: 회의 종료
        }
        
        FinalSummary --> TranslationOption: 번역 필요?
        TranslationOption --> Translate: 번역 플러그인 호출
        TranslationOption --> Done: 완료
        Translate --> Done
    }

    BASE --> WITH_PLUGIN: 플러그인 설치
```

---

## 7. Agent Hub

### 7.1 Agent Hub Architecture

Agent Hub는 전 사원 레플리카 에이전트들의 소통 창구이자 메시지 보드다. 사원 카피 DB의 개념으로, 각 사원의 디지털 트윈이 비동기적으로 협업한다.

```mermaid
graph TB
    subgraph "Agent Hub Server"
        MSG_BOARD["Message Board<br/>(게시판 + 메시지 큐)"]
        
        subgraph "Agent Registry"
            REG["Agent 등록/관리"]
            PROFILE["Agent Profile DB<br/>(사원 정보, 역할, 전문분야)"]
            STATUS["Agent Status<br/>(온라인/오프라인/작업중)"]
        end

        subgraph "Message Routing"
            DIRECT_MSG["Direct Message<br/>(1:1 에이전트 간)"]
            BOARD_POST["Board Post<br/>(공개 게시)"]
            CHANNEL_MSG["Channel Message<br/>(팀/부서 채널)"]
            BROADCAST["Broadcast<br/>(전사 공지)"]
        end

        subgraph "Agent Runtime"
            EXECUTOR["Async Executor"]
            TASK_QUEUE["Task Queue"]
            RESULT_STORE["Result Store"]
        end
    end

    subgraph "Employee Replica Agents"
        AGENT_A["Agent A<br/>(김철수 레플리카)"]
        AGENT_B["Agent B<br/>(이영희 레플리카)"]
        AGENT_C["Agent C<br/>(박민수 레플리카)"]
    end

    AGENT_A <-->|"메시지"| MSG_BOARD
    AGENT_B <-->|"메시지"| MSG_BOARD
    AGENT_C <-->|"메시지"| MSG_BOARD

    MSG_BOARD --> DIRECT_MSG
    MSG_BOARD --> BOARD_POST
    MSG_BOARD --> CHANNEL_MSG
    MSG_BOARD --> BROADCAST

    DIRECT_MSG --> EXECUTOR
    BOARD_POST --> EXECUTOR
    EXECUTOR --> TASK_QUEUE
    TASK_QUEUE --> RESULT_STORE
```

### 7.2 Agent Communication Flow

```mermaid
sequenceDiagram
    participant UserA as 김철수 (Client)
    participant AgentA as 김철수 Agent (Replica)
    participant Hub as Agent Hub (Message Board)
    participant AgentB as 이영희 Agent (Replica)
    participant UserB as 이영희 (Client)
    participant Lgenie as Lgenie

    UserA->>AgentA: "@이영희 지난 Q1 마케팅 보고서 공유해줄 수 있어?"
    AgentA->>Hub: Direct Message → 이영희 Agent
    Hub->>AgentB: 메시지 전달 (비동기 큐)
    
    alt 이영희 온라인
        AgentB->>UserB: 알림: "김철수님이 Q1 보고서 요청"
        UserB->>AgentB: "보내줘"
        AgentB->>Hub: 파일 첨부 응답
    else 이영희 오프라인
        AgentB->>Lgenie: Context 조회 (권한 확인)
        Lgenie-->>AgentB: 권한 OK + 파일 위치
        AgentB->>AgentB: 자동 응답 판단
        AgentB->>Hub: 자동 응답 + 파일 공유
    end
    
    Hub->>AgentA: 응답 전달
    AgentA->>UserA: "이영희님의 Q1 보고서입니다"
```

### 7.3 Board Types

| 보드 유형 | 용도 | 접근 권한 | 예시 |
|----------|------|----------|------|
| **Personal Mailbox** | 개인 에이전트 간 1:1 비동기 메시지 | 발신자 + 수신자 | "이 문서 검토해줘" |
| **Team Channel** | 팀/부서 단위 에이전트 협업 | 팀 소속 에이전트 | "이번 주 이슈 정리" |
| **Project Board** | 프로젝트별 작업 추적 및 공유 | 프로젝트 참여자 | "Sprint #12 태스크" |
| **Knowledge Board** | 전사 지식 공유 및 Q&A | 전 사원 에이전트 | "사내 Wi-Fi 설정법" |
| **Broadcast** | 전사 공지, 긴급 알림 | 관리자 발신, 전체 수신 | "시스템 점검 안내" |

---

## 8. Marketplace Hub

### 8.1 Marketplace Architecture

각 사업부가 운영하는 서비스/홈페이지를 API 기반으로 LVIS 클라이언트와 연동하는 플러그인 생태계.

```mermaid
graph TB
    subgraph "Marketplace Hub Server"
        STORE["Plugin Store<br/>(검색, 설치, 업데이트)"]
        SPEC_REG["Plugin Spec Registry<br/>(구축 가이드)"]
        REVIEW["Review & Approval<br/>(보안 검증)"]
        ANALYTICS["Usage Analytics"]
    end

    subgraph "BU Plugin Examples"
        BU_HR["HR Portal Plugin<br/>( 인사 시스템 API)"]
        BU_IT["IT Helpdesk Plugin<br/>(IT 지원 API)"]
        BU_FIN["Finance Plugin<br/>(회계 시스템 API)"]
        BU_MKT["Marketing Plugin<br/>(캠페인 관리 API)"]
    end

    subgraph "Plugin Development Kit"
        SDK["LVIS Plugin SDK"]
        CLI_TOOL["lvis-plugin-cli<br/>(scaffold, build, publish)"]
        TEMPLATE["Project Templates"]
        DOC["API Documentation"]
        SANDBOX["Plugin Sandbox<br/>(테스트 환경)"]
    end

    BU_HR --> REVIEW
    BU_IT --> REVIEW
    BU_FIN --> REVIEW
    BU_MKT --> REVIEW
    REVIEW --> STORE

    SDK --> CLI_TOOL
    CLI_TOOL --> TEMPLATE
    SPEC_REG --> DOC
    DOC --> SDK
```

### 8.2 Plugin Development Spec

사업부가 플러그인을 구축할 때 따라야 하는 스펙:

```mermaid
flowchart LR
    subgraph "Plugin Build Spec"
        direction TB
        S1["1. manifest.json 작성<br/>(메타데이터, 권한, 키워드)"]
        S2["2. API Connector 구현<br/>(사업부 시스템 연동)"]
        S3["3. Skill 정의<br/>(트리거 키워드, 실행 로직)"]
        S4["4. UI 컴포넌트 구현<br/>(React, 선택사항)"]
        S5["5. Hook 구현<br/>(Pre/PostToolUse, 선택사항)"]
        S6["6. 테스트 & Sandbox 검증"]
        S7["7. 보안 심사 & 배포"]
        
        S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7
    end
```

### 8.3 API Gateway Pattern

```mermaid
graph LR
    CLIENT["LVIS Client"] -->|"Plugin API Call"| GW["API Gateway"]
    
    GW -->|"Auth + Rate Limit"| AUTH["Auth Middleware"]
    AUTH --> ROUTER["Service Router"]
    
    ROUTER -->|"/hr/*"| HR["HR System API"]
    ROUTER -->|"/it/*"| IT["IT Helpdesk API"]
    ROUTER -->|"/finance/*"| FIN["Finance API"]
    ROUTER -->|"/marketing/*"| MKT["Marketing API"]
    
    HR --> TRANSFORM["Response Transformer"]
    IT --> TRANSFORM
    FIN --> TRANSFORM
    MKT --> TRANSFORM
    
    TRANSFORM -->|"Unified JSON"| CLIENT
```

---

## 9. Data Flow

### 9.1 End-to-End Data Flow

사용자의 질의가 시스템 전체를 관통하는 흐름:

```mermaid
flowchart TB
    USER["👤 사용자 입력<br/>'회의록 작성해줘'"]
    
    subgraph "Client (Local)"
        KW["① Keyword Engine<br/>'회의록' 키워드 감지"]
        ROUTE["② Route Engine<br/>meeting-recorder 플러그인 매칭"]
        LOCAL_CTX["③ Local Index<br/>최근 회의 일정 조회"]
        PLUGIN_ACT["④ Plugin Activate<br/>회의록 UI 활성화"]
    end

    subgraph "Plugin Execution"
        STT["⑤ STT Tool<br/>음성 → 텍스트"]
        MID_SUM["⑥ Mid-Summary<br/>중간 요약 생성"]
        FINAL["⑦ Final Summary<br/>최종 회의록"]
    end

    subgraph "Server"
        LGENIE_CALL["⑧ Lgenie 추론<br/>요약/정리/포맷팅"]
        AGENT_SHARE["⑨ Agent Hub<br/>참석자 에이전트에 공유"]
        SRV_STORE_SAVE["⑩ Server Store<br/>회의록 영구 저장"]
    end

    USER --> KW --> ROUTE --> LOCAL_CTX --> PLUGIN_ACT
    PLUGIN_ACT --> STT --> MID_SUM --> FINAL
    MID_SUM -->|"LLM 요약"| LGENIE_CALL
    FINAL -->|"LLM 포맷팅"| LGENIE_CALL
    FINAL --> AGENT_SHARE --> SRV_STORE_SAVE

    LGENIE_CALL -->|"요약 결과"| MID_SUM
    LGENIE_CALL -->|"최종 문서"| FINAL
```

### 9.2 Indexing Data Flow

```mermaid
flowchart LR
    subgraph "Local Sources"
        L1["로컬 파일시스템"]
        L2["대화 이력"]
        L3["기억 저장소"]
    end

    subgraph "Server Sources"
        S1["전사 문서 서버"]
        S2["지식 베이스"]
        S3["이메일 아카이브"]
    end

    subgraph "Local Index Engine"
        WATCH["File Watcher"]
        PARSE["Parser"]
        EMBED["Embedder"]
        L_STORE["Local Vector + FTS"]
    end

    subgraph "Server Index Engine"
        CRAWL["Crawler"]
        S_PARSE["Parser"]
        S_EMBED["Embedder"]
        S_STORE["Server Vector + FTS"]
    end

    subgraph "Unified Query"
        HYBRID_Q["Hybrid Search<br/>(Local + Server)"]
        RANK["RRF Ranker"]
        RESULT["검색 결과"]
    end

    L1 --> WATCH --> PARSE --> EMBED --> L_STORE
    L2 --> PARSE
    L3 --> PARSE

    S1 --> CRAWL --> S_PARSE --> S_EMBED --> S_STORE
    S2 --> CRAWL
    S3 --> CRAWL

    L_STORE --> HYBRID_Q
    S_STORE --> HYBRID_Q
    HYBRID_Q --> RANK --> RESULT
```

---

## 10. Deployment Topology

### 10.1 Physical Deployment

```mermaid
graph TB
    subgraph "Employee PC (Desktop/Laptop)"
        ELECTRON["LVIS Client (Electron)"]
        LOCAL_ENGINE["Core Engines<br/>(Keyword/Route/Index)"]
        LOCAL_DATA["Local Store<br/>(SQLite + VectorDB)"]
        PLUGINS_LOCAL["Installed Plugins"]

        ELECTRON --- LOCAL_ENGINE
        LOCAL_ENGINE --- LOCAL_DATA
        ELECTRON --- PLUGINS_LOCAL
    end

    subgraph "On-Premise Datacenter"
        subgraph "Lgenie Cluster"
            LLM_LB["Load Balancer"]
            LLM_1["Lgenie Node 1"]
            LLM_2["Lgenie Node 2"]
            LLM_N["Lgenie Node N"]
            LLM_LB --> LLM_1
            LLM_LB --> LLM_2
            LLM_LB --> LLM_N
        end

        subgraph "Agent Hub Cluster"
            AH_LB["Load Balancer"]
            AH_APP["Agent Hub App"]
            AH_DB["Agent DB<br/>(PostgreSQL)"]
            AH_MQ["Message Queue<br/>(Redis/NATS)"]
            AH_LB --> AH_APP
            AH_APP --> AH_DB
            AH_APP --> AH_MQ
        end

        subgraph "Marketplace Cluster"
            MK_LB["Load Balancer"]
            MK_APP["Marketplace App"]
            MK_STORE["Plugin Store<br/>(Object Storage)"]
            MK_DB["Marketplace DB"]
            MK_LB --> MK_APP
            MK_APP --> MK_STORE
            MK_APP --> MK_DB
        end

        subgraph "Server Index Cluster"
            IDX_APP["Index Service"]
            IDX_VEC["Vector Store<br/>(Milvus/Qdrant)"]
            IDX_ES["Search Engine<br/>(Elasticsearch)"]
            IDX_APP --> IDX_VEC
            IDX_APP --> IDX_ES
        end
    end

    ELECTRON <-->|"WSS/gRPC"| LLM_LB
    ELECTRON <-->|"HTTPS"| AH_LB
    ELECTRON <-->|"HTTPS"| MK_LB
    LOCAL_ENGINE <-->|"HTTPS"| IDX_APP
```

### 10.2 Technology Stack Summary

| Layer | Component | Technology |
|-------|-----------|------------|
| **Client** | App Shell | Electron + React |
| **Client** | Core Engines | Rust (Native Module via NAPI-RS) |
| **Client** | Local Store | SQLite + FTS5 |
| **Client** | Local Vector | HNSW (hnswlib) / LanceDB |
| **Client** | Plugin Runtime | Sandboxed V8 / WebAssembly |
| **Server** | Lgenie | 사내 LLM 시스템 (독자 인프라) |
| **Server** | Agent Hub | Go/Rust + PostgreSQL + Redis/NATS |
| **Server** | Marketplace | Node.js/Go + Object Storage |
| **Server** | Server Index | Elasticsearch + Milvus/Qdrant |
| **Comm** | Client↔Server | WebSocket (streaming), gRPC (structured), REST (CRUD) |
| **Auth** | Identity | SSO/LDAP 연동 |

---

## Appendix A: Harness Reference (claw-code)

LVIS 클라이언트 코어의 에이전트 루프는 [claw-code](https://github.com/ultraworkers/claw-code) 하네스에서 다음 패턴을 차용한다:

| claw-code 패턴 | LVIS 적용 |
|---------------|----------|
| `ConversationRuntime.run_turn()` | Agent Loop — 사용자 입력 → 도구 실행 → LLM 추론 반복 루프 |
| `SlashCommand::parse()` | Keyword Detecting Engine의 명령어 감지 |
| `resolve_skill_invocation()` | 스킬 키워드 매칭 및 플러그인 활성화 |
| `CliToolExecutor` trait | Agent Route Engine의 도구 디스패치 인터페이스 |
| `PluginHooks` (Pre/PostToolUse) | Plugin Hook 시스템 — 플러그인이 도구 실행을 가로채거나 보강 |
| `GlobalToolRegistry` | 동적 Tool Registry — 플러그인이 도구를 런타임에 등록 |
| `PermissionPolicy` | 권한 관리 — 도구별, 플러그인별 접근 제어 |
| `Session` persistence | 세션 관리 — 대화 이력 저장 및 재개 |
| `HookRunner` | Hook Runner — 플러그인 훅의 실행 및 결과 머지 |
| Multi-provider `ApiClient` | Lgenie Session — 사내 LLM 엔드포인트 추상화 |

## Appendix B: Key Design Decisions

| 결정 | 이유 | 트레이드오프 |
|------|------|------------|
| Electron 기반 클라이언트 | 크로스 플랫폼 + 웹 기술 기반 UI 확장 | 메모리 사용량 ↑ |
| Rust Native Module (NAPI-RS) | 키워드 감지/인덱싱의 성능 보장 | 개발 복잡도 ↑ |
| 로컬 Vector DB | 네트워크 없이도 의미 검색 가능 | 로컬 스토리지 사용 ↑ |
| Plugin Sandbox (V8/WASM) | 플러그인 격리로 보안 확보 | 플러그인 기능 일부 제한 |
| Message Board 기반 Agent Hub | 비동기 협업, 사원 부재 시에도 동작 | 실시간성 다소 부족 |
| API Gateway 기반 Marketplace | 사업부별 독립 배포 가능 | Gateway 단일 장애점 |

---

> **Next Steps**: philosophy.md 공유 후 철학 섹션 보강, 각 엔진의 상세 인터페이스 정의(IDL/Proto), Plugin SDK 상세 가이드 작성
