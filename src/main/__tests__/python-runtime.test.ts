/**
 * python-runtime.test.ts
 *
 * PythonRuntimeBootstrapper 단위 테스트.
 * node:fs/promises, node:child_process를 mock하여 실제 uv/Python 없이 검증.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";
import path from "node:path";

// ─── electron mock ────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  default: {},
}));

// ─── node:fs/promises mock ────────────────────────────────────────────────────
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
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
const mockedReadFile = vi.mocked(fsMock.readFile);
const mockedSpawn = vi.mocked(cpMock.spawn);

function normalizePathForAssert(value: string): string {
  return value.replace(/\\/g, "/").replace(/^[A-Z]:/i, "");
}

function expectArgsToContainPath(args: string[], expectedPath: string): void {
  expect(args.map(normalizePathForAssert)).toContain(normalizePathForAssert(path.normalize(expectedPath)));
}

function expectArgsNotToContainPath(args: string[], expectedPath: string): void {
  expect(args.map(normalizePathForAssert)).not.toContain(normalizePathForAssert(path.normalize(expectedPath)));
}

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
    mockedReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
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
    const manifestPath = "/installed/local-indexer/plugin.json";
    const lockFilePath = "/installed/local-indexer/python-requirements.lock";
    // access 첫 호출(sentinel): ENOENT, 이후 uv binary, plugin-adjacent lockfile: OK
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
      .mockResolvedValueOnce(undefined) // uv binary 존재
      .mockResolvedValueOnce(undefined); // lock file 존재 (plugin manifest dir)

    // spawn 호출들: python install, venv, pip sync, python verify
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n")) // uv python install
      .mockReturnValueOnce(makeSpawnMock(""))             // uv venv
      .mockReturnValueOnce(makeSpawnMock(""))             // uv pip sync
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));   // python -c verify

    const bootstrapper = new PythonRuntimeBootstrapper({ pluginManifestPaths: [manifestPath] });
    const win = makeBrowserWindow();
    const result = await bootstrapper.ensureReady(win);

    // uv python install 3.12 was invoked
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["python", "install", "3.12"]),
      expect.anything(),
    );

    // uv venv was invoked
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["venv"]),
      expect.anything(),
    );

    // uv pip sync was invoked without --frozen (uv 0.7.x 미지원)
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["pip", "sync"]),
      expect.anything(),
    );
    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expect(pipSyncCall![1] as string[]).not.toContain("--frozen");
    expectArgsToContainPath(pipSyncCall![1] as string[], lockFilePath);

    // result 유효
    expect(result.pythonPath).toBeTruthy();
    expect(result.venvPath).toBeTruthy();
  });

  it("plugin.json이 선언한 상대 lockfile 경로를 manifest 디렉토리 기준으로 해석한다", async () => {
    const manifestPath = "/installed/local-indexer/plugin.json";
    const declaredLockFilePath = "/installed/local-indexer/requirements/python.lock";
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      python: { managedBy: "lvis-app", requirementsLock: "requirements/python.lock" },
    }));
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
      .mockResolvedValueOnce(undefined) // uv binary 존재
      .mockResolvedValueOnce(undefined); // declared lock file 존재
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper({ pluginManifestPaths: [manifestPath] });
    await bootstrapper.ensureReady(makeBrowserWindow());

    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expectArgsToContainPath(pipSyncCall![1] as string[], declaredLockFilePath);
  });

  it("registry discovery ignores Python lockfiles from non-document-indexer plugins", async () => {
    const registryPath = "/registry/plugins.json";
    mockedReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path === registryPath) {
        return JSON.stringify({
          plugins: [
            { id: "other-python", manifestPath: "/installed/other/plugin.json", enabled: true },
            { id: "local-indexer", manifestPath: "/installed/local-indexer/plugin.json", enabled: true },
          ],
        });
      }
      if (path === "/installed/other/plugin.json") {
        return JSON.stringify({
          id: "other-python",
          python: { managedBy: "lvis-app", requirementsLock: "python-requirements.lock" },
          capabilities: ["some-other-python-capability"],
        });
      }
      if (path === "/installed/local-indexer/plugin.json") {
        return JSON.stringify({
          id: "local-indexer",
          python: { managedBy: "lvis-app", requirementsLock: "python-requirements.lock" },
          capabilities: ["document-indexer"],
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockedAccess.mockImplementation(async (filePath) => {
      const normalizedPath = normalizePathForAssert(String(filePath));
      if (normalizedPath.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (normalizedPath.endsWith("/uv") || normalizedPath.endsWith("/uv.exe")) return undefined;
      if (normalizedPath === "/installed/local-indexer/python-requirements.lock") return undefined;
      if (normalizedPath === "/installed/other/python-requirements.lock") return undefined;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper({ registryPath });
    await bootstrapper.ensureReady(makeBrowserWindow());

    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expectArgsToContainPath(pipSyncCall![1] as string[], "/installed/local-indexer/python-requirements.lock");
    expectArgsNotToContainPath(pipSyncCall![1] as string[], "/installed/other/python-requirements.lock");
  });

  it("plugin.json이 선언한 절대 lockfile 경로는 거부하고 plugin 디렉토리 기본 lockfile만 사용한다", async () => {
    const manifestPath = "/installed/local-indexer/plugin.json";
    const defaultLockFilePath = "/installed/local-indexer/python-requirements.lock";
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      runtime: { python: { requirementsLock: "/outside/python.lock" } },
    }));
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper({ pluginManifestPaths: [manifestPath] });
    await bootstrapper.ensureReady(makeBrowserWindow());

    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expectArgsToContainPath(pipSyncCall![1] as string[], defaultLockFilePath);
    expectArgsNotToContainPath(pipSyncCall![1] as string[], "/outside/python.lock");
  });

  it("first-session plugin install can prepare runtime from the newly installed manifest", async () => {
    const manifestPath = "/installed/local-indexer/plugin.json";
    const declaredLockFilePath = "/installed/local-indexer/requirements/python.lock";
    mockedReadFile.mockResolvedValue(JSON.stringify({
      runtime: { python: { requirementsLock: "requirements/python.lock" } },
    }));
    mockedAccess
      .mockResolvedValueOnce(undefined) // preflight declared lock exists
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // sentinel 없음
      .mockResolvedValueOnce(undefined) // uv binary 존재
      .mockResolvedValueOnce(undefined); // declared lock file 존재
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper();
    const result = await bootstrapper.ensureReadyForPluginManifest(manifestPath, makeBrowserWindow());

    expect(result?.pythonPath).toBeTruthy();
    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expectArgsToContainPath(pipSyncCall![1] as string[], declaredLockFilePath);
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
      ["win32", "x64", "win32-x64"],
      ["linux", "x64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
    ];

    for (const [platform, arch, expectedDir] of cases) {
      it(`${platform}/${arch} → resources/uv/${expectedDir}/uv[.exe]`, async () => {
        mockedAccess
          .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          .mockResolvedValueOnce(undefined);
        mockedSpawn.mockReturnValueOnce(makeSpawnFailMock(1, "stop after uv path assertion"));

        const originalPlatform = process.platform;
        const originalArch = process.arch;

        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        Object.defineProperty(process, "arch", { value: arch, configurable: true });

        try {
          const bootstrapper = new PythonRuntimeBootstrapper();
          const win = makeBrowserWindow();

          await expect(bootstrapper.ensureReady(win)).rejects.toThrow();
          const uvPath = String(mockedSpawn.mock.calls[0]?.[0] ?? "");
          expect(normalizePathForAssert(uvPath)).toContain(
            normalizePathForAssert(`/resources/uv/${expectedDir}/${platform === "win32" ? "uv.exe" : "uv"}`),
          );
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

    it("macOS Intel은 .ready sentinel이 있어도 지원하지 않는다", async () => {
      mockedAccess.mockResolvedValue(undefined);

      const originalPlatform = process.platform;
      const originalArch = process.arch;

      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper();
        const win = makeBrowserWindow();
        await expect(bootstrapper.ensureReady(win)).rejects.toThrow(
          "지원하지 않는 플랫폼/아키텍처: darwin/x64",
        );
        expect(mockedSpawn).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });

    it("macOS Intel은 지원하지 않는다", async () => {
      mockedAccess
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        .mockResolvedValueOnce(undefined);

      const originalPlatform = process.platform;
      const originalArch = process.arch;

      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper();
        const win = makeBrowserWindow();
        await expect(bootstrapper.ensureReady(win)).rejects.toThrow(
          "지원하지 않는 플랫폼/아키텍처: darwin/x64",
        );
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      }
    });
  });
});
