// AUTO-GENERATED — i18n migration. Source: src/main/python-runtime.ts. Do not edit by hand.
export const en = {
  // setupIfStillNeeded: runtime ready from cache
  "be_pythonRuntime.statusReadyCached": "Python runtime ready (cached)",

  // setup: step 1 — uv binary not found
  "be_pythonRuntime.errUvBinaryNotFound": "uv binary not found: {uvBin}\nRun \"npm run postinstall\" or \"node scripts/fetch-uv.mjs\" first.",

  // setup: step 2 — installing Python
  "be_pythonRuntime.statusInstallingPython": "Installing Python 3.12...",

  // setup: step 3 — creating venv
  "be_pythonRuntime.statusCreatingVenv": "Creating Python venv...",

  // setup: step 4 — installing dependencies
  "be_pythonRuntime.statusInstallingDeps": "Installing dependencies (first run)...",

  // setup: step 5 — verifying installation
  "be_pythonRuntime.statusVerifying": "Verifying installation...",

  // setup: step 6 — runtime ready
  "be_pythonRuntime.statusReady": "Python runtime ready",

  // findLockFile: lock file not found
  "be_pythonRuntime.errLockFileNotFound": "python-requirements.lock file not found.\nSearch paths:\n{paths}",
  "be_pythonRuntime.errLockFileNone": "- (none)",

  // runUv: uv process errors
  "be_pythonRuntime.errUvExecEnoent": "uv binary execution failed (ENOENT): {uvBin}",
  "be_pythonRuntime.errUvExecError": "uv execution error: {message}",
  "be_pythonRuntime.errUvCommandFailed": "uv command failed (exit {code}): uv {args}\nstderr: {stderr}",

  // runPython: Python process errors
  "be_pythonRuntime.errPythonExecEnoent": "Python binary execution failed (ENOENT): {pythonBin}",
  "be_pythonRuntime.errPythonExecError": "Python execution error: {message}",
  "be_pythonRuntime.errPythonVerifyFailed": "Python verification failed (exit {code})\nstdout: {stdout}\nstderr: {stderr}",

  // verifyImports: runtime verification failure
  "be_pythonRuntime.errRuntimeVerifyFailed": "Python runtime verification failed.\nCause: {message}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_pythonRuntime.statusReadyCached": "Python 런타임 준비 완료 (캐시)",
  "be_pythonRuntime.errUvBinaryNotFound": "uv binary를 찾을 수 없습니다: {uvBin}\n\"npm run postinstall\" 또는 \"node scripts/fetch-uv.mjs\"를 먼저 실행하세요.",
  "be_pythonRuntime.statusInstallingPython": "Python 3.12 설치 중...",
  "be_pythonRuntime.statusCreatingVenv": "Python venv 생성 중...",
  "be_pythonRuntime.statusInstallingDeps": "의존성 설치 중 (최초 1회)...",
  "be_pythonRuntime.statusVerifying": "설치 검증 중...",
  "be_pythonRuntime.statusReady": "Python 런타임 준비 완료",
  "be_pythonRuntime.errLockFileNotFound": "python-requirements.lock 파일을 찾을 수 없습니다.\n검색 경로:\n{paths}",
  "be_pythonRuntime.errLockFileNone": "- (없음)",
  "be_pythonRuntime.errUvExecEnoent": "uv binary 실행 실패 (ENOENT): {uvBin}",
  "be_pythonRuntime.errUvExecError": "uv 실행 오류: {message}",
  "be_pythonRuntime.errUvCommandFailed": "uv 명령 실패 (exit {code}): uv {args}\nstderr: {stderr}",
  "be_pythonRuntime.errPythonExecEnoent": "Python binary 실행 실패 (ENOENT): {pythonBin}",
  "be_pythonRuntime.errPythonExecError": "Python 실행 오류: {message}",
  "be_pythonRuntime.errPythonVerifyFailed": "Python 검증 실패 (exit {code})\nstdout: {stdout}\nstderr: {stderr}",
  "be_pythonRuntime.errRuntimeVerifyFailed": "Python 런타임 검증 실패.\n원인: {message}",
};
