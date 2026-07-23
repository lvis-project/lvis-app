# Knip 기준선

이 문서는 검토된 dead-code 기준선이다. 실제로 제거할 수 있는 코드와 정적
분석만으로는 추론할 수 없는 런타임·패키징 사용을 분리하면서, snapshot 밖의
새 이슈는 차단한다.

## 게이트

Run:

```powershell
bun run check:knip
```

명령은 설치된 devDependency가 정확히 `knip@6.23.0`인지 검증한 뒤 실행하고,
정규화된 결과를 `knip-baseline.json`과 비교한다. 기준선에는 이슈 유형, 파일,
심볼 이름만 기록하므로 소스 줄 이동은 거짓 drift를 만들지 않는다.

다음 조건에서는 실패한다.

- 검토된 snapshot에 없는 새 file, export, type, duplicate, dependency 이슈
- 모든 unresolved import, unlisted dependency, 미등록 host binary. 이 유형은
  기준선에 기록할 수 없다.
- Knip config 로드 오류, 버전 불일치, 잘못된 JSON, 지원하지 않는 기준선 schema

새 unused 파일이 실제로 거부되는 결정적 검증은 다음과 같다.

```powershell
bun run test:knip-gate
```

검증은 저장소 밖의 임시 프로젝트를 사용하고 종료 후 삭제하므로 동시에 실행된
저장소 scan과 경합하지 않는다. 의도된 부채 변경을 검토한 뒤에만
`bun run check:knip:update`로 기준선을 갱신한다. 이 명령은 같은 디렉터리의
staging 파일을 flush한 뒤 원자 교체하므로 중단된 갱신이 검토된 기준선을
잘라내지 않는다.

현재 snapshot은 file 25건, export 234건, type 353건, duplicate export group
7건, devDependency 7건 등 총 626건을 허용한다. 기존 항목이 해소된 경우에는
실패시키지 않고 기준선을 축소하라는 안내를 출력한다.

`vitest.config.ts`는 계속 실제 runtime assertion 경계다. Knip은 순수한
`vitest.analysis.config.ts`를 읽으므로 정적 분석이 Electron 전용 Vitest 계약을
우회하거나 잘못 실행하지 않는다. 중첩 `web` package는 별도 workspace로
모델링한다. `next` binary는 `web/bun.lock`으로 설치되므로 desktop root
workflow는 `web/node_modules` 없이도 선언을 분석할 수 있다.

## 허용된 런타임 및 패키징 사용

- `better-sqlite3` is rebuilt in `postinstall`, staged by
  `scripts/packaged-runtime-assets.mjs`, guarded by package footprint tests, and
  kept external by `scripts/build-main-esbuild.mjs`.
- `electron-updater` is dynamically required by `src/main/auto-updater.ts` so
  tests can run without loading the native Electron updater implementation.
- `pino-pretty` is selected by `src/lib/logger.ts` as a runtime transport and
  must remain a real `node_modules` entry for Pino worker resolution.
- `@sentry/electron` is optional crash-reporting integration loaded by guarded
  dynamic `require()` in `src/main/crash-reporter.ts`.
- `electron-builder` is invoked through `bunx electron-builder` from
  `scripts/build-installers.mjs`.
- `shadcn` is retained as the registry/tooling source for the design-system
  primitives recorded in `components.json` and `docs/development/theme-system.md`.

`ignoreBinaries`의 OS binary는 플랫폼별 script/test가 의도적으로 호출하는 host
도구다.

## 현재 제거 후보

Split these into separate PRs with focused regression checks before deleting:

- Files currently reported by Knip: dormant scripts, test fixtures,
  `src/plugin-ui-shell.js`, `src/shared/host-font-stack.ts`,
  `src/ui/renderer/components/LvisLogo.tsx`, and
  `src/ui/renderer/hooks/use-auth-progress.ts`.
- 계속 경고되는 dependency 후보에는 `@ai-sdk/devtools`,
  `baseline-browser-mapping`, `caniuse-lite`, `tw-animate-css`가 있다. 제거 전
  패키징 또는 CSS 전용 사용을 확인해야 한다.
- Export/type candidates across shared renderer, runtime, plugin, permission,
  i18n, and work-board surfaces. Treat public API and test seams as separate
  review buckets; do not auto-delete exported symbols from Knip output alone.

## 이 기준선에서 검증된 수정

- `src/ui/renderer/tabs/__tests__/test-helpers.ts` now imports `HookTrustRow`
  from the actual source module, `src/hooks/hook-trust-commands.ts`, instead of
  the stale `hook-trust-store.js` path.
- workspace-aware 분석으로 미사용 web `accordion`, `card`, `scroll-area`,
  `separator` primitive와 관련 Radix dependency 4개를 제거했다.
