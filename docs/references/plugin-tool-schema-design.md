# Plugin Schema Design — LVIS

**Status:** v2 Core  
**Updated:** 2026-04-18

---

## 핵심 설계 원칙

플러그인은 `HostApi`를 통해 자기 자신을 등록한다. 호스트 앱은 플러그인별 코드를 포함하지 않는다.

---

## PluginManifestV2 인터페이스

```typescript
interface PluginManifestV2 {
  id: string;                  // dot 형식: "com.lge.meeting-recorder"
  name: string;
  version: string;
  entry: string;               // 플러그인 진입점 JS
  methods: string[];           // LLM 툴 이름 목록 (underscore 형식)
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  capabilities?: string[];
  startupMethods?: string[];
  eventSubscriptions?: string[];
  ipcBindings?: PluginIpcBinding[];
  deployment?: "managed" | "user";
  publisher?: string;
}
```

---

## HostApi 메서드

플러그인이 호스트에 접근하는 유일한 경로:

| 메서드 | 설명 |
|--------|------|
| `registerKeywords(keywords)` | KeywordEngine에 트리거 키워드 등록 |
| `emitEvent(name, payload)` | 다른 플러그인·호스트에 이벤트 발행 |
| `onEvent(name, handler)` | 이벤트 구독 |
| `addTask(task)` | LVIS 태스크 생성 |
| `saveNote(note)` | `~/.lvis/notes/`에 메모 저장 |
| `getSecret(key)` | 암호화된 API 키 조회 |
| `getMsGraphToken()` | Microsoft Graph 토큰 (Office365 플러그인용) |

---

## Tool 명명 규칙

- LLM에 노출되는 tool name은 **underscore 형식**: `meeting_start`, `index_scan`, `email_list`
- 플러그인 ID는 dot 형식 유지: `com.lge.meeting-recorder`
- 이벤트 채널 이름은 dot 형식: `meeting.started`, `calendar.event.created`
- `methods[]`에는 underscore 형식 이름을 직접 선언 (런타임 변환 없음)

---

## 번들 플러그인

| 플러그인 | ID | 주요 methods |
|---------|-----|-------------|
| Meeting Recorder | `com.lge.meeting-recorder` | `meeting_start`, `meeting_stop`, `meeting_summarize` |
| PageIndex | `lvis-plugin-pageindex` | `index_scan`, `chat_preview` |
| Email | `lvis-plugin-email` | `email_list`, `email_get`, `email_create_task` |
| Calendar | `lvis-plugin-calendar` | `calendar_today`, `calendar_list` |

---

## Deployment 모드

| 항목 | `managed` | `user` |
|------|-----------|--------|
| 설치 주체 | 회사 IT Admin | 사용자 직접 |
| 삭제 권한 | 회사만 가능 | 사용자 자유 |
| 업데이트 | 정책 push 시 강제 | 사용자 opt-in |
| 저장 경로 | `~/.lvis/plugins/managed/` | `~/.lvis/plugins/user/` |

상세 설계: `docs/architecture/plugin-deployment-model.md`

---

## 현행 코드 참조

| 역할 | 파일 |
|------|------|
| PluginManifest 타입 | `src/plugins/types.ts` |
| 플러그인 런타임 | `src/plugins/runtime.ts` |
| Deployment 가드 | `src/plugins/deployment-guard.ts` |
| 등록 진입점 | `src/boot.ts` |
