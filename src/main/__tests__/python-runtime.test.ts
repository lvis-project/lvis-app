/**
 * python-runtime.test.ts
 *
 * PythonRuntimeBootstrapper 단위 테스트.
 * node:fs/promises, node:child_process를 mock하여 실제 uv/Python 없이 검증.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";

// ─── electron mock ────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  default: {},
}));

// ─── node:fs/promises mock ────────────────────────────────────────────────────
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

// ─── node:child_process mock ──────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

import * as fsMock from "node:fs/promises";
import * as cpMock from "node:child_process";

const mockedAccess = vi.mocked(fsMock.access);
const mockedSpawn = vi.mocked(cpMock.spawn);

/**
 * 성공하는 spawn 프로세스 mock을 반환한다.
 * stdout으로 stdoutData를 방출한 뒤 exit 0.
 */
function makeSpawnMock(stdoutData = "ok\n", exitCode = 0) {
  const stdout = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") setTimeout(() => cb(Buffer.from(stdoutData)), 0);
    }),
  };
  const stderr = {
    on: vi.fn((_event: string, _cb: unknown) => {}),
  };
  const proc = {
    stdout,
    stderr,
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
    }),
  };
  return proc as unknown as ReturnType<typeof cpMock.spawn>;
}

/**
 * 실패하는 spawn mock (non-zero exit).
 */
function makeSpawnFailMock(exitCode = 1, stderrMsg = "some error") {
  const stdout = {
    on: vi.fn((_event: string, _cb: unknown) => {}),
  };
  const stderr = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") setTimeout(() => cb(Buffer.from(stderrMsg)), 0);
    }),
  };
  const proc = {
    stdout,
    stderr,
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), 0);
    }),
  };
  return proc as unknown as ReturnType<typeof cpMock.spawn>;
}

// ─── 테스트 대상 import (mock 설정 이후) ──────────────────────────────────────
// dynamic import를 사용하지 않고 상단에서 import → vi.mock hoisting에 의존
import { PythonRuntimeBootstrapper } from "../python-runtime.js";

// ─── BrowserWindow stub ───────────────────────────────────────────────────────
function makeBrowserWindow() {
  return {
    webContents: {
      send: vi.fn(),
    },
  } as unknown as import("electron").BrowserWindow;
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

describe("PythonRuntimeBootstrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // process.resourcesPath를 undefined로 설정 (개발 환경 시뮬레이션)
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── 1. .ready sentinel 존재 시 즉시 resolve ─────────────────────────────

  it(".ready sentinel이 존재하면 spawn 없이 즉시 resolve한다", async () => {
    // access → sentinel 존재 (resolve without error)
    mockedAccess.mockResolvedValue(undefined);

    const bootstrapper = new PythonRuntimeBootstrapper();
    const win = makeBrowserWindow();
    const result = await bootstrapper.ensureReady(win);

    // spawn이 전혀 호출되지 않아야 함
    expect(mockedSpawn).not.toHaveBeenCalled();

    // 결과에 pythonPath, venvPath 포함
    expect(result.pythonPath).toBeTruthy();
    expect(result.venvPath).toBeTruthy();
    expect(result.pythonPath).toContain("python");

    // IPC로 ready 상태 발행
    expect(win.webContents.send).toHaveBeenCalledWith(
      "bootstrap.status",
      expect.objectContaining({ phase: "ready", pct: 100 })
    );
  });

  // ─── 2. .ready 부재 시 spawn 호출 ────────────────────────────────────────

  it(".ready sentinel이 없으면 uv spawn을 호출한다", async () => {
    // access 첫 호출(sentinel): ENOENT, 이후 uv binary, lockfile: OK
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
      .mockResolvedValueOnce(undefined) // uv binary 존재
      .mockResolvedValueOnce(undefined); // lock file 존재 (devPath)

    // spawn 호출들: python install, venv, pip sync, python verify
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n")) // uv python install
      .mockReturnValueOnce(makeSpawnMock(""))             // uv venv
      .mockReturnValueOnce(makeSpawnMock(""))             // uv pip sync
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));   // python -c verify

    const bootstrapper = new PythonRuntimeBootstrapper();
    const win = makeBrowserWindow();
    const result = await bootstrapper.ensureReady(win);

    // spawn이 4번 호출 (python install, venv, pip sync, python verify)
    expect(mockedSpawn).toHaveBeenCalledTimes(4);

    // 첫 번째 spawn: uv python install 3.12
    const [firstBin, firstArgs] = mockedSpawn.mock.calls[0] as [string, string[]];
    expect(firstArgs).toContain("python");
    expect(firstArgs).toContain("install");
    expect(firstArgs).toContain("3.12");

    // 두 번째 spawn: uv venv
    const [, secondArgs] = mockedSpawn.mock.calls[1] as [string, string[]];
    expect(secondArgs).toContain("venv");

    // 세 번째 spawn: uv pip sync --frozen
    const [, thirdArgs] = mockedSpawn.mock.calls[2] as [string, string[]];
    expect(thirdArgs).toContain("pip");
    expect(thirdArgs).toContain("sync");
    expect(thirdArgs).toContain("--frozen");

    // result 유효
    expect(result.pythonPath).toBeTruthy();
    expect(result.venvPath).toBeTruthy();
  });

  // ─── 3. spawn non-zero exit → throws ─────────────────────────────────────

  it("uv spawn이 non-zero exit code를 반환하면 throws한다", async () => {
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
      .mockResolvedValueOnce(undefined); // uv binary 존재

    // uv python install이 exit 1로 실패
    mockedSpawn.mockReturnValueOnce(makeSpawnFailMock(1, "network error"));

    const bootstrapper = new PythonRuntimeBootstrapper();
    const win = makeBrowserWindow();

    await expect(bootstrapper.ensureReady(win)).rejects.toThrow();
  });

  // ─── 4. 두 번째 ensureReady는 idempotent ─────────────────────────────────

  it("두 번째 ensureReady 호출은 .ready sentinel을 확인하고 즉시 resolve한다", async () => {
    // 두 번 모두 sentinel 존재
    mockedAccess.mockResolvedValue(undefined);

    const bootstrapper = new PythonRuntimeBootstrapper();
    const win = makeBrowserWindow();

    const r1 = await bootstrapper.ensureReady(win);
    const r2 = await bootstrapper.ensureReady(win);

    // spawn 호출 없음
    expect(mockedSpawn).not.toHaveBeenCalled();
    // 두 결과 동일
    expect(r1.pythonPath).toBe(r2.pythonPath);
    expect(r1.venvPath).toBe(r2.venvPath);
  });

  // ─── 5. 플랫폼별 binary path 정확성 ─────────────────────────────────────

  describe("플랫폼별 uv binary path 결정", () => {
    const cases: Array<[string, string, string]> = [
      ["darwin", "arm64", "darwin-arm64"],
      ["darwin", "x64", "darwin-x64"],
      ["win32", "x64", "win32-x64"],
      ["linux", "x64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
    ];

    for (const [platform, arch, expectedDir] of cases) {
      it(`${platform}/${arch} → resources/uv/${expectedDir}/uv[.exe]`, () => {
        const originalPlatform = process.platform;
        const originalArch = process.arch;

        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        Object.defineProperty(process, "arch", { value: arch, configurable: true });

        try {
          const bootstrapper = new PythonRuntimeBootstrapper();
          // getPythonPath는 public이므로 직접 호출 가능
          const pythonPath = bootstrapper.getPythonPath();

          if (platform === "win32") {
            expect(pythonPath).toContain("Scripts");
            expect(pythonPath).toContain("python.exe");
          } else {
            expect(pythonPath).toContain("bin/python");
          }
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
          Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
        }
      });
    }

    it("지원하지 않는 플랫폼/arch에서는 ensureReady가 throw한다", async () => {
      mockedAccess
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
        .mockResolvedValueOnce(undefined); // uv binary exists (but wrong platform)

      const originalPlatform = process.platform;
      const originalArch = process.arch;

      Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper();
        const win = makeBrowserWindow();
        await expect(bootstrapper.ensureReady(win)).rejects.toThrow();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });
  });
});
