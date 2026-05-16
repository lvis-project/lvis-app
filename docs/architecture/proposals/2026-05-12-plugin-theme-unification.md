# Plugin Theme Application — Unification

- Status: Proposal (decided — implementation gated on PR sequence below)
- Owner: arch
- Date: 2026-05-12
- Scope: 모든 LVIS 플러그인의 webview 테마 적용 패턴 통일
- Decision: **Option A — SDK `primeTheme(bridge, opts?)` + `useTheme(bridge, opts?)` 확장 + Token JSON SoT**
- Related docs:
  - `docs/architecture/architecture.md` §6.7 (Theme & Design Tokens), §6.7.1 (Plugin webview theme propagation)
  - `docs/references/plugin-tool-schema-design.md` §2.6 (UI Styling Tokens — `--lvis-*` 화이트리스트)
- Related memory: `project-theme-prime-followups` (P0/P1/P2 트랙 동일)

---

## 1. Problem

호스트 → 플러그인 webview 테마 동기화 contract (§6.7.1 의 `host.theme.changed`
broadcast + sticky replay + `getTheme()` pull) 자체는 견고하지만, **플러그인 측
글루 코드가 5 개 레포에 손-복제** 되면서 운영 부담이 누적됐다.

### Current state — `grep` 실측 (2026-05-12)

| 플러그인 | UI entry | 현재 테마 적용 코드 |
|---|---|---|
| `lvis-plugin-work-assistant` | React | `useTheme(bridge)` 만 — `src/ui/detector-control.tsx:66`. prime 없음 |
| `lvis-plugin-agent-hub` | React | `useTheme(bridge)` + 별도 `lvisPlugin.getTheme()` pre-mount pull + **두 번째** `bridge.onEvent("host.theme.changed")` + 800ms wait + `.ah-root` scoped mirror — `src/ui/work-board-panel.tsx:602-684` |
| `lvis-plugin-meeting` | vanilla JS + detached BrowserWindow | `src/ui/meeting-control.js:2380` 직접 `onEvent` + `recorder-window-preload.cjs:50` 별도 preload re-broadcast + `recorder-window.js:1087` 별도 fallback paint **3 곳 분기** |
| `lvis-plugin-local-indexer` | vanilla JS (scoped sidebar) | local helper `theme-sync.js:setupThemeSync(scope, bridge)` — `documentElement` 대신 scoped root, OS-preference fallback 포함 |
| `lvis-plugin-corp-portal` | vanilla JS + detached BrowserWindow | local helper `corp-portal-control.js:765-778 bootstrapHostTheme` — `getTheme()` + `onEvent` |
| `lvis-plugin-ms-graph` | UI 없음 | 해당 없음 |
| `lvis-plugin-template` | docs only | `scripts/check-ui-tokens.mjs` 주석만 |

### 식별된 5 가지 pain point

1. **Pre-mount prime 보일러플레이트 중복** — agent-hub 의 `lvisPlugin.getTheme()` + `applyThemeFromHostEvent` 글루가 React 플러그인마다 거의 그대로 복사 (50+ LOC × N 레포).
2. **`useTheme` rigid → 이중 subscribe** — agent-hub 가 `useTheme` 외에 같은 채널을 한 번 더 `bridge.onEvent` 로 잡아 sidebar custom 토큰 매핑 (`work-board-panel.tsx:661`). 같은 이벤트를 두 번 구독은 비정상.
3. **`_FALLBACK_CSS` 다크 1색 하드코딩** — host first-boot 시점에 light/HC/LG-accent 이면 첫 프레임 검은 깜빡임. SDK `inject.ts:23-41` 의 `_FALLBACK_CSS`.
4. **3-place lockstep 부담** — `lvis-app/src/ui/renderer/theme/plugin-token-map.ts` (`_DARK_BASE`) ↔ `lvis-plugin-sdk/src/ui/tokens/lvis-tokens.css` (`:root`) ↔ `lvis-plugin-sdk/src/ui/tokens/inject.ts` (`_FALLBACK_CSS`) 셋이 손-lockstep. 디자인 팔레트 1번 바뀔 때마다 3 파일 동시 수정.
5. **React / vanilla-JS entry 분기** — `useTheme`(React) 와 `applyThemeFromHostEvent`(vanilla) 둘 다 `document.documentElement` 만 target. detached BrowserWindow (meeting recorder, corp-portal detached) 와 scoped sidebar (local-indexer) 는 SDK API 가 못 가리켜서 각 플러그인이 자체 helper 작성.

## 2. Options considered

| 방향 | 무엇 | Trade-off |
|---|---|---|
| **A. SDK `primeTheme` + `useTheme(opts)`** | `getTheme()` + `applyThemeFromHostEvent` + `onEvent` 자동 subscribe 를 한 헬퍼로. `{ target?, onPayload? }` 옵션으로 detached/scoped 와 custom 매핑 흡수. | 가장 작은 변경, 호스트 surface 무변경. SDK + 플러그인 sweep 만. |
| **B. 호스트 preload-time CSS 주입** | `plugin-ui-shell` 가 inline `<style>` 까지 head 에 prepend → 플러그인 측 prime 호출 불필요 | detached BrowserWindow / scoped sidebar 는 plugin-ui-shell 이 host 하지 않는 문서라 부분 해결. preload bootstrap 회귀면 큼. |
| **C. `lvis-host://theme.css` 공유 stylesheet** | `<link>` 한 줄. 호스트가 protocol handler 로 응답 | CSP `style-src` + protocol scheme + 토글마다 URL 버전 핀 갱신. 동적 토큰 모델과 충돌. 회귀면 너무 큼. |
| **D. 현 3-layer 유지 + CI lockstep 가드** | 표면만 봉합 | pain 1·2·3·5 모두 미해결. |

### Why A

- **호스트 surface 무변경** → 회귀면이 SDK + 플러그인에 한정. B/C 는 protocol/CSP/shell 동시 회귀면.
- **단일 API surface** → React (`useTheme`) / vanilla (`primeTheme`) 가 같은 내부를 공유. detached BrowserWindow / scoped sidebar 가 `{ target }` 한 인자로 흡수.
- **이중 subscribe 정당화** → `useTheme(bridge, { onPayload })` 콜백이 sidebar custom 매핑 use-case 를 흡수 → 같은 이벤트를 두 번 구독할 필요 사라짐.
- **lockstep 해소를 같이 묶음** → `<sdk>/tokens/fallback-dark.json` JSON SoT 도입. `_FALLBACK_CSS` / `lvis-tokens.css :root` / 호스트 `_DARK_BASE` 모두 빌드타임 generate / re-import. CI snapshot 1개로 가드.

### Why not B/C/D

- B 는 detached / scoped 못 커버해서 결국 이중 모델. 매력적인 "플러그인 코드 0줄" 은 부분 적용.
- C 는 token 이 동적 (settings 토글) 이라 URL 스킴이 dynamic-content 처럼 동작해야 하고, CSP / install / sandbox 회귀면이 큼.
- D 는 pain 1·2·3·5 미해결 — 부채 봉합만.

## 3. Target API

### SDK 측 (`@lvis/plugin-sdk/ui`)

```ts
// new — single entry that all plugins call from mount()
function primeTheme(
  bridge: PluginBridge,
  opts?: {
    target?: Document | HTMLElement,  // default: document.documentElement
    onPayload?: (e: LvisHostThemeEvent) => void,
  }
): { dispose(): void };

// extended — useTheme is now a React wrapper around primeTheme
function useTheme(
  bridge: PluginBridge,
  opts?: {
    target?: Document | HTMLElement,
    onPayload?: (e: LvisHostThemeEvent) => void,
  }
): void;

// extended — applyThemeTokens accepts target
function applyThemeTokens(
  tokens: Record<string, string>,
  target?: Document | HTMLElement
): void;
```

### Plugin 측 mount contract

모든 플러그인의 `mount(host)` 의 **첫 await** 는 `primeTheme(bridge, opts?)` 호출
이다. `getEntryUrl()` 직후, 플러그인 React render / vanilla append 이전.

```ts
// React 플러그인 (work-assistant / agent-hub)
export function mount(host: PluginHost): PluginInstance {
  const bridge = host.bridge;
  // ① theme prime — first await, before any React render
  primeTheme(bridge);
  // ② React mount
  const root = createRoot(host.container);
  root.render(<App bridge={bridge} />);
  // App 내부:
  //   useTheme(bridge, { onPayload: (e) => mapSidebarTokens(e) });  // custom 매핑 케이스
  return { unmount: () => root.unmount() };
}

// vanilla 플러그인 + detached window (corp-portal / meeting recorder)
export function mount(host: PluginHost): PluginInstance {
  // detached window 가 별도 BrowserWindow 의 document 라면 target 명시
  primeTheme(host.bridge, { target: host.targetDocument ?? document });
  // … plugin DOM build …
}

// scoped sidebar (local-indexer)
const scope = document.querySelector(".my-sidebar-root")!;
primeTheme(host.bridge, { target: scope });
```

### 보안 가드 (변경 없음)

- 토큰 key: `LVIS_TOKEN_NAMES` allowlist
- 토큰 value: `url(`/`expression(`/`<tag` regex 차단
- `bundleId` / `shell` whitelist
- 호스트 `validateThemePayload` 가 broadcast 시 동일 화이트리스트 적용

## 4. Token SoT 통합 (lockstep 해소)

기존 3 곳 lockstep 을 단일 JSON SoT 로:

```
lvis-plugin-sdk/src/ui/tokens/fallback-dark.json    ← Single SoT
                                  │
                                  ├─ generated → inject.ts        _FALLBACK_CSS
                                  ├─ generated → lvis-tokens.css  :root
                                  └─ re-export → lvis-app         _DARK_BASE
```

- SDK 빌드 스크립트가 JSON 을 읽어 `_FALLBACK_CSS` TS const 와 `:root` CSS rule
  을 generate.
- 호스트는 `@lvis/plugin-sdk/tokens/fallback-dark.json` 을 직접 import.
- CI snapshot 단위 테스트 1개로 3 artifact 가 SoT 와 일치하는지 가드.

light/HC flicker (pain 3) 의 본질적 해소는 fallback CSS 1색이라는 제약 그 자체.
완화 경로: `plugin-ui-shell.js` 가 token 미수신 시 OS `prefers-color-scheme` 만
`data-shell` 에 반영 (이미 `local-indexer/theme-sync.js:42 getInitialTheme` 의
패턴). 호스트 cold-boot 시 `lastThemePayload` 가 보통 ready 이므로 flicker
window 는 host first-boot 한정.

## 5. Migration sequence

| # | 레포 | 변경 | 트랙 | 비고 |
|---|---|---|---|---|
| 1 | `lvis-app` | `plugin-ui-shell` prime 을 detached-window / scoped sidebar parity 까지 확장 | P0 | SDK 변경 없음. meeting recorder / corp-portal detached 측 host 측 paint 가 먼저 통일. |
| 2 | `lvis-plugin-sdk` | `fallback-dark.json` 신설 + `_FALLBACK_CSS` / `lvis-tokens.css` build-time generate + `primeTheme` export + `useTheme` 옵션 + `applyThemeTokens(target)` | P1 | Backward-compat: 기존 `useTheme(bridge)` 호출자는 그대로 동작. SDK semver minor bump + 마켓 publish. |
| 3 | `lvis-app` | `plugin-token-map.ts` 의 `_DARK_BASE` 를 SDK JSON 에서 re-import | P1 | PR-2 와 같은 세션 (host-plugin-contract-sync). |
| 4 | `lvis-plugin-template` | `scripts/check-ui-tokens.mjs` 가 `primeTheme` 사용 권장 패턴 명시. 새 플러그인 scaffold 가 `mount() { primeTheme(bridge); … }` 한 줄 자동 생성 | — | docs + template only. |
| 5 | `lvis-plugin-work-assistant` | SDK bump smoke. `useTheme(bridge)` 무변경 (no-op) | — | 가장 단순. SDK upgrade smoke 역할. |
| 6 | `lvis-plugin-local-indexer` | `theme-sync.js` 삭제 → `primeTheme(bridge, { target: scope })` 한 줄. OS-preference fallback 은 SDK 측 흡수 | — | |
| 7 | `lvis-plugin-corp-portal` | `bootstrapHostTheme` 삭제 → `primeTheme(bridge, { target: detachedDoc })` 한 줄 | — | PR-1 (host detached-window parity) 머지 후. |
| 8 | `lvis-plugin-agent-hub` | `applyThemePayload` + 두 번째 `onEvent` + 800ms wait 전체 삭제 → `useTheme(bridge, { target: root, onPayload: (p) => mapSidebarTokens(p) })` 한 줄 | P2 | sidebar custom 매핑은 `onPayload` 콜백으로. |
| 9 | `lvis-plugin-meeting` | `meeting-control.js` + `recorder-window.js` 의 두 곳 prime 을 `primeTheme(bridge, { target: targetDoc })` 로 통합 | — | 3 곳 분기가 1 곳으로. |
| 10 | (cleanup) | `useTheme` backward-compat 제거 검토 → SDK v4 major bump 대상으로 보류 | — | 즉시 처리 X. |

## 6. Validation gates

- e2e: `bunx playwright test` — light/dark/HC × 모든 활성 플러그인 paint 회귀.
  (CLAUDE.md "Playwright Verification" 룰)
- 단위: SDK 의 JSON ↔ CSS ↔ TS 3-artifact lockstep snapshot.
- 회귀: `grep -rn "applyThemeFromHostEvent\|bootstrapHostTheme\|setupThemeSync\|applyHostThemePayload" lvis-plugin-*` 0건이 PR-9 머지 후 통과해야 함.

## 7. References

- `lvis-app/src/ipc/domains/plugins.ts:121,165-170,1033,1230` — sticky cache + replay + IPC + broadcast
- `lvis-app/src/plugin-preload.ts:71,148` — `STICKY_EVENT_TYPES` + `lvisPlugin.getTheme`
- `lvis-app/src/plugin-ui-shell.js:64-95` — pre-mount prime (이미 host 측에 존재)
- `lvis-plugin-sdk/src/ui/hooks/useTheme.ts` — React 훅
- `lvis-plugin-sdk/src/ui/tokens/inject.ts:23-41,75-83,105-129` — `_FALLBACK_CSS` + `applyThemeTokens` + `applyThemeFromHostEvent`
- `lvis-plugin-agent-hub/src/ui/work-board-panel.tsx:602-684` — 5-source prime 패턴 (가장 복잡)
- `lvis-plugin-meeting/src/ui/meeting-control.js:2376-2380` · `recorder-window.js:1087` · `recorder-window-preload.cjs:50` — 3 곳 분기
- `lvis-plugin-local-indexer/src/ui/theme-sync.js` — scoped sidebar pattern
- `lvis-plugin-corp-portal/src/ui/corp-portal-control.js:765-778` — detached window pattern
