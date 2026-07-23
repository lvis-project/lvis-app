# 메인 프로세스 번들 예산

LVIS는 전체 host-service graph를 읽기 전에 bootstrap window를 만들 수 있도록
Electron main-process entry 크기를 제한한다. 기존 빌드는 10,828,547바이트 ESM
파일 하나를 만들었으므로 `createWindow()` 실행 전 모든 boot, provider, plugin,
locale 코드를 parse했다.

현재 빌드는 esbuild ESM splitting을 사용한다. `src/main.ts`는 window를 만든 뒤
`import("./boot.js")`를 시작하고 corporate CA 확인을 병렬로 수행한 다음 boot
module을 기다린다. 이는 loading 순서만 바꾸며 `bootstrap()` 내부 service 구성
순서는 바꾸지 않는다.

## 강제 예산

`bun run build:main`은 esbuild metafile에서 static import closure를 계산하고 다음
한도를 넘으면 실패한다.

| 측정값 | 한도 |
| --- | ---: |
| Entry file | 1,700,000바이트 |
| 초기 static closure | 5,250,000바이트 |
| 전체 main-process JavaScript | 11,000,000바이트 |

비동기 경계가 사라져도 실패한다. 도입 시점 측정값은 entry 1,538,075바이트,
초기 4,832,914바이트, 75개 파일 전체 10,476,094바이트다. 기존 단일 bundle과
비교해 동기 loading 바이트가 55.4% 감소했다.

초기 측정은 `import-statement` edge만 따라가며 dynamic import는 runtime이
요청할 때까지 제외한다. 전체 바이트에는 모든 chunk가 포함되므로 코드를 async
edge 뒤로 옮겨 전체 bundle 증가를 숨길 수 없다.

## 패키징 계약

One-shot build는 content hash chunk를 만들기 전에 기존
`dist/src/main/chunks`를 삭제한다. 또한 모든 예상 파일과 바이트 수를 기록한
`dist/src/main/bundle-manifest.json`을 만든다. packaged footprint gate는 manifest,
모든 listed chunk, 일치하는 packaged byte 수를 요구하고 stale main-process
chunk를 거부한다.

생성된 manifest를 직접 수정하거나 CI 통과만을 위해 예산을 올리지 않는다.
한도를 바꾸기 전에 변경된 graph를 측정하고 새 동기 책임의 이유와 초기·전체
바이트를 함께 검토한다.
