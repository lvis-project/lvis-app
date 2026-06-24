/**
 * python-runtime.test.ts
 *
 * PythonRuntimeBootstrapper 단위 테스트.
 * node:fs/promises, node:child_process를 mock하여 실제 uv/Python 없이 검증.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

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
  chmod: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

// ─── node:child_process mock ──────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// ─── ASRT sandbox mock ────────────────────────────────────────────────────────
// The OS tool sandbox gate is decided once at boot; here we control it per-test.
// Default OFF so every pre-existing test keeps the unchanged plain-spawn path.
const asrtState = { active: false };
const mockWrapWorkerCommand = vi.fn(
  async (command: string) => ({
    argv: ["/bin/sh", "-c", command],
    env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://localhost:8080" } as NodeJS.ProcessEnv,
  }),
);
const mockCleanupAsrt = vi.fn();
vi.mock("../../permissions/asrt-sandbox.js", () => ({
  isAsrtSandboxActive: () => asrtState.active,
  wrapWorkerCommand: (...args: unknown[]) =>
    mockWrapWorkerCommand(...(args as [string, unknown])),
  cleanupAsrtSandboxAfterCommand: () => mockCleanupAsrt(),
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

function expectedRuntimePath(...segments: string[]): string {
  const lvisRoot = process.env.LVIS_HOME ?? path.join(homedir(), ".lvis");
  return normalizePathForAssert(path.join(lvisRoot, "runtime", ...segments));
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

function makeSpawnMockWithStderr(stderrChunks: string[], stdoutData = "", exitCode = 0) {
  const stdout = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data" && stdoutData.length > 0) setTimeout(() => cb(Buffer.from(stdoutData)), 0);
    }),
  };
  const stderr = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event !== "data") return;
      stderrChunks.forEach((chunk, index) => {
        setTimeout(() => cb(Buffer.from(chunk)), index);
      });
    }),
  };
  const proc = {
    stdout,
    stderr,
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "close") setTimeout(() => cb(exitCode), stderrChunks.length + 1);
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

function setupPythonRuntimeSetupSpawns(): void {
  mockedAccess
    .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined);
  mockedSpawn
    .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
    .mockReturnValueOnce(makeSpawnMock(""))
    .mockReturnValueOnce(makeSpawnMock(""))
    .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));
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
    vi.resetAllMocks();
    // ASRT gate defaults OFF; re-establish the wrap mock impl after resetAllMocks.
    asrtState.active = false;
    mockWrapWorkerCommand.mockImplementation(async (command: string) => ({
      argv: ["/bin/sh", "-c", command],
      env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://localhost:8080" } as NodeJS.ProcessEnv,
    }));
    vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsMock.appendFile).mockResolvedValue(undefined);
    vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsMock.rename).mockResolvedValue(undefined);
    vi.mocked(fsMock.chmod).mockResolvedValue(undefined);
    mockedReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // readdir default — repairLegacyUvBinaries calls readdir on uvRuntimeDir;
    // most tests don't care, so default to ENOENT (no uv binaries) and let
    // sweep tests override per-case.
    vi.mocked(fsMock.readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
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

  it("uv stderr 다운로드 로그를 chunk 단위로 main log에 증폭하지 않는다", async () => {
    const manifestPath = "/installed/local-indexer/plugin.json";
    const stderrChunks = Array.from(
      { length: 25 },
      (_, index) => `Downloading package-${index} (${index + 1}.0MiB)\n`,
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockedAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMockWithStderr(stderrChunks))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper({ pluginManifestPaths: [manifestPath] });
    await bootstrapper.ensureReady(makeBrowserWindow());

    const loggedLines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(loggedLines.some((line) => line.includes("[uv stdout]"))).toBe(false);
    expect(loggedLines.some((line) => line.includes("[uv stderr]"))).toBe(false);
    expect(loggedLines.filter((line) => line.includes("uv stderr suppressed; retained tail for failures"))).toHaveLength(1);
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

  it("registry discovery uses host-managed Python lockfiles without document-indexer hardcoding", async () => {
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
    expectArgsToContainPath(pipSyncCall![1] as string[], "/installed/other/python-requirements.lock");
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
    mockedReadFile.mockImplementation(async (filePath) => {
      if (String(filePath) === declaredLockFilePath) return "pymupdf==1.26.0\n";
      return JSON.stringify({
        runtime: { python: { requirementsLock: "requirements/python.lock" } },
      });
    });
    mockedAccess.mockImplementation(async (filePath) => {
      const normalized = normalizePathForAssert(String(filePath));
      if (normalized === normalizePathForAssert(declaredLockFilePath)) return undefined;
      if (normalized.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return undefined;
    });
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper();
    const result = await bootstrapper.ensureReadyForPluginManifest(manifestPath, makeBrowserWindow());

    expect(result?.pythonPath).toBeTruthy();
    expect(normalizePathForAssert(result!.venvPath)).toContain("/python-envs/");
    const pipSyncCall = mockedSpawn.mock.calls.find(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCall).toBeDefined();
    expectArgsToContainPath(pipSyncCall![1] as string[], declaredLockFilePath);
  });

  it("deduplicates concurrent setup for plugins with the same lockfile content", async () => {
    const manifestA = "/installed/a/plugin.json";
    const manifestB = "/installed/b/plugin.json";
    const lockA = "/installed/a/python-requirements.lock";
    const lockB = "/installed/b/python-requirements.lock";
    mockedReadFile.mockImplementation(async (filePath) => {
      const p = normalizePathForAssert(String(filePath));
      if (p === normalizePathForAssert(manifestA) || p === normalizePathForAssert(manifestB)) {
        return JSON.stringify({ python: { managedBy: "lvis-app" } });
      }
      if (p === normalizePathForAssert(lockA) || p === normalizePathForAssert(lockB)) {
        return "shared-package==1.0.0\n";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockedAccess.mockImplementation(async (filePath) => {
      const p = normalizePathForAssert(String(filePath));
      if (p.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return undefined;
    });
    mockedSpawn.mockImplementation(() => makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper();
    const [runtimeA, runtimeB] = await Promise.all([
      bootstrapper.ensureReadyForPluginManifest(manifestA, makeBrowserWindow()),
      bootstrapper.ensureReadyForPluginManifest(manifestB, makeBrowserWindow()),
    ]);

    expect(runtimeA?.venvPath).toBe(runtimeB?.venvPath);
    expect(mockedSpawn).toHaveBeenCalledTimes(4);
    const pipSyncCalls = mockedSpawn.mock.calls.filter(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCalls).toHaveLength(1);
  });

  it("keeps concurrent setup separate for different lockfile content", async () => {
    const manifestA = "/installed/a/plugin.json";
    const manifestB = "/installed/b/plugin.json";
    const lockA = "/installed/a/python-requirements.lock";
    const lockB = "/installed/b/python-requirements.lock";
    mockedReadFile.mockImplementation(async (filePath) => {
      const p = normalizePathForAssert(String(filePath));
      if (p === normalizePathForAssert(manifestA) || p === normalizePathForAssert(manifestB)) {
        return JSON.stringify({ python: { managedBy: "lvis-app" } });
      }
      if (p === normalizePathForAssert(lockA)) return "package-a==1.0.0\n";
      if (p === normalizePathForAssert(lockB)) return "package-b==1.0.0\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockedAccess.mockImplementation(async (filePath) => {
      const p = normalizePathForAssert(String(filePath));
      if (p.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return undefined;
    });
    mockedSpawn.mockImplementation(() => makeSpawnMock("3.12.3\n"));

    const bootstrapper = new PythonRuntimeBootstrapper();
    const [runtimeA, runtimeB] = await Promise.all([
      bootstrapper.ensureReadyForPluginManifest(manifestA, makeBrowserWindow()),
      bootstrapper.ensureReadyForPluginManifest(manifestB, makeBrowserWindow()),
    ]);

    expect(runtimeA?.venvPath).toBeTruthy();
    expect(runtimeB?.venvPath).toBeTruthy();
    expect(runtimeA?.venvPath).not.toBe(runtimeB?.venvPath);
    expect(mockedSpawn).toHaveBeenCalledTimes(8);
    const pipSyncCalls = mockedSpawn.mock.calls.filter(
      ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
    );
    expect(pipSyncCalls).toHaveLength(2);
  });

  it("packaged Electron에서는 gzip uv archive를 사용자 런타임 캐시에 materialize한다", async () => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "lvis-packaged-resources-"));
    const uvRuntimeDir = mkdtempSync(path.join(tmpdir(), "lvis-uv-runtime-"));
    const manifestRoot = mkdtempSync(path.join(tmpdir(), "lvis-python-plugin-"));
    const manifestPath = path.join(manifestRoot, "plugin.json");
    const lockFilePath = path.join(manifestRoot, "python-requirements.lock");
    const packagedUvDir = path.join(resourcesPath, "uv", "linux-arm64");
    const uvSha = "f0c6469da6ce77395335e1dd05f3d03411b1a674c17332769d301275b5496f12";
    const expectedUvBin = path.join(uvRuntimeDir, "linux-arm64", uvSha, "uv");

    mkdirSync(packagedUvDir, { recursive: true });
    writeFileSync(path.join(packagedUvDir, "uv.gz"), gzipSync(Buffer.from("uv-bin")));
    writeFileSync(path.join(packagedUvDir, "uv.meta.json"), JSON.stringify({ binarySha256: uvSha }));
    writeFileSync(manifestPath, JSON.stringify({ python: { managedBy: "lvis-app" } }));
    writeFileSync(lockFilePath, "");

    const originalPlatform = process.platform;
    const originalArch = process.arch;
    const originalDefaultApp = (process as { defaultApp?: boolean }).defaultApp;
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    (process as { defaultApp?: boolean }).defaultApp = false;
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;

    mockedReadFile.mockResolvedValue(JSON.stringify({ python: { managedBy: "lvis-app" } }));
    mockedAccess.mockImplementation(async (filePath) => {
      const normalizedPath = normalizePathForAssert(String(filePath));
      if (normalizedPath.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (normalizePathForAssert(String(filePath)) === normalizePathForAssert(expectedUvBin)) return undefined;
      if (normalizePathForAssert(String(filePath)) === normalizePathForAssert(lockFilePath)) return undefined;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    try {
      const bootstrapper = new PythonRuntimeBootstrapper({
        pluginManifestPaths: [manifestPath],
        uvRuntimeDir,
      });
      await bootstrapper.ensureReady(makeBrowserWindow());

      expect(existsSync(expectedUvBin)).toBe(true);
      expect(readFileSync(expectedUvBin, "utf8")).toBe("uv-bin");
      expect(mockedSpawn.mock.calls[0]?.[0]).toBe(expectedUvBin);
      const pipSyncCall = mockedSpawn.mock.calls.find(
        ([, args]) => (args as string[]).includes("pip") && (args as string[]).includes("sync"),
      );
      expect(pipSyncCall).toBeDefined();
      expectArgsToContainPath(pipSyncCall![1] as string[], lockFilePath);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
      (process as { defaultApp?: boolean }).defaultApp = originalDefaultApp;
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      rmSync(resourcesPath, { recursive: true, force: true });
      rmSync(uvRuntimeDir, { recursive: true, force: true });
      rmSync(manifestRoot, { recursive: true, force: true });
    }
  });

  it("packaged Electron에서 .ready sentinel이 있으면 uv materialize 없이 resolve한다", async () => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "lvis-packaged-ready-resources-"));
    const uvRuntimeDir = mkdtempSync(path.join(tmpdir(), "lvis-packaged-ready-uv-"));
    const targetDirName = `${process.platform}-${process.arch}`;
    const binName = process.platform === "win32" ? "uv.exe" : "uv";
    const packagedUvDir = path.join(resourcesPath, "uv", targetDirName);
    const uvSha = "4561e9cbacc2878e64dbdcc60796818bd3c026eb1c1097467fe09730284bb170";
    const expectedUvBin = path.join(uvRuntimeDir, targetDirName, uvSha, binName);

    mkdirSync(packagedUvDir, { recursive: true });
    writeFileSync(path.join(packagedUvDir, `${binName}.gz`), gzipSync(Buffer.from("ready-uv-bin")));
    writeFileSync(path.join(packagedUvDir, "uv.meta.json"), JSON.stringify({ binarySha256: uvSha }));

    const originalDefaultApp = (process as { defaultApp?: boolean }).defaultApp;
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as { defaultApp?: boolean }).defaultApp = false;
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;
    mockedAccess.mockResolvedValue(undefined);

    try {
      const bootstrapper = new PythonRuntimeBootstrapper({ uvRuntimeDir });
      await bootstrapper.ensureReady(makeBrowserWindow());

      expect(existsSync(expectedUvBin)).toBe(false);
      expect(mockedSpawn).not.toHaveBeenCalled();
    } finally {
      (process as { defaultApp?: boolean }).defaultApp = originalDefaultApp;
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      rmSync(resourcesPath, { recursive: true, force: true });
      rmSync(uvRuntimeDir, { recursive: true, force: true });
    }
  });

  it("packaged uv archive SHA가 metadata와 다르면 실행하지 않는다", async () => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "lvis-packaged-bad-sha-resources-"));
    const uvRuntimeDir = mkdtempSync(path.join(tmpdir(), "lvis-packaged-bad-sha-uv-"));
    const targetDirName = `${process.platform}-${process.arch}`;
    const binName = process.platform === "win32" ? "uv.exe" : "uv";
    const packagedUvDir = path.join(resourcesPath, "uv", targetDirName);

    mkdirSync(packagedUvDir, { recursive: true });
    writeFileSync(path.join(packagedUvDir, `${binName}.gz`), gzipSync(Buffer.from("ready-uv-bin")));
    writeFileSync(path.join(packagedUvDir, "uv.meta.json"), JSON.stringify({
      binarySha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }));

    const originalDefaultApp = (process as { defaultApp?: boolean }).defaultApp;
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as { defaultApp?: boolean }).defaultApp = false;
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;
    mockedAccess.mockResolvedValue(undefined);

    try {
      const bootstrapper = new PythonRuntimeBootstrapper({ uvRuntimeDir, forceSetup: true });
      await expect(bootstrapper.ensureReady(makeBrowserWindow())).rejects.toThrow(/SHA mismatch/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    } finally {
      (process as { defaultApp?: boolean }).defaultApp = originalDefaultApp;
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      rmSync(resourcesPath, { recursive: true, force: true });
      rmSync(uvRuntimeDir, { recursive: true, force: true });
    }
  });

  it("packaged uv 캐시 파일 SHA가 다르면 archive에서 다시 materialize한다", async () => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "lvis-packaged-cache-sha-resources-"));
    const uvRuntimeDir = mkdtempSync(path.join(tmpdir(), "lvis-packaged-cache-sha-uv-"));
    const pluginRoot = mkdtempSync(path.join(tmpdir(), "lvis-packaged-cache-sha-plugin-"));
    const targetDirName = `${process.platform}-${process.arch}`;
    const binName = process.platform === "win32" ? "uv.exe" : "uv";
    const packagedUvDir = path.join(resourcesPath, "uv", targetDirName);
    const uvSha = "4561e9cbacc2878e64dbdcc60796818bd3c026eb1c1097467fe09730284bb170";
    const expectedUvBin = path.join(uvRuntimeDir, targetDirName, uvSha, binName);

    mkdirSync(packagedUvDir, { recursive: true });
    mkdirSync(path.dirname(expectedUvBin), { recursive: true });
    writeFileSync(path.join(packagedUvDir, `${binName}.gz`), gzipSync(Buffer.from("ready-uv-bin")));
    writeFileSync(path.join(packagedUvDir, "uv.meta.json"), JSON.stringify({ binarySha256: uvSha }));
    writeFileSync(expectedUvBin, "stale-uv-bin");
    writeFileSync(path.join(pluginRoot, "python-requirements.lock"), "");

    const originalDefaultApp = (process as { defaultApp?: boolean }).defaultApp;
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as { defaultApp?: boolean }).defaultApp = false;
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;
    mockedAccess.mockResolvedValue(undefined);
    mockedSpawn
      .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock(""))
      .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

    try {
      const bootstrapper = new PythonRuntimeBootstrapper({
        pluginRoots: [pluginRoot],
        uvRuntimeDir,
        forceSetup: true,
      });
      await bootstrapper.ensureReady(makeBrowserWindow());

      expect(readFileSync(expectedUvBin, "utf8")).toBe("ready-uv-bin");
      expect(mockedSpawn.mock.calls[0]?.[0]).toBe(expectedUvBin);
    } finally {
      (process as { defaultApp?: boolean }).defaultApp = originalDefaultApp;
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
      rmSync(resourcesPath, { recursive: true, force: true });
      rmSync(uvRuntimeDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  // ─── issue #713: uv cache co-located with venv (cross-volume hardlink fix) ─

  describe("issue #713 — uv cache cross-volume hardlink fix", () => {
    function uvSpawnEnvs(): NodeJS.ProcessEnv[] {
      return mockedSpawn.mock.calls
        .filter(([bin]) => {
          const s = String(bin);
          return s.endsWith("uv") || s.endsWith("uv.exe");
        })
        .map(([, , opts]) => (opts as SpawnOptionsWithoutStdio).env ?? {});
    }

    it("기본적으로 UV_CACHE_DIR을 LVIS runtime uv-cache 로 설정한다", async () => {
      delete process.env.UV_CACHE_DIR;
      delete process.env.UV_LINK_MODE;
      setupPythonRuntimeSetupSpawns();

      const bootstrapper = new PythonRuntimeBootstrapper({
        pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
      });
      await bootstrapper.ensureReady(makeBrowserWindow());

      const envs = uvSpawnEnvs();
      expect(envs.length).toBeGreaterThan(0);
      for (const env of envs) {
        expect(env.UV_CACHE_DIR).toBeDefined();
        expect(normalizePathForAssert(String(env.UV_CACHE_DIR))).toBe(expectedRuntimePath("uv-cache"));
      }
    });

    it("사용자가 설정한 UV_CACHE_DIR / UV_LINK_MODE 가 spawn env 로 전파된다", async () => {
      const userCache = path.join(tmpdir(), "lvis-test-uv-user-cache");
      process.env.UV_CACHE_DIR = userCache;
      process.env.UV_LINK_MODE = "copy";
      try {
        setupPythonRuntimeSetupSpawns();

        const bootstrapper = new PythonRuntimeBootstrapper({
          pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
        });
        await bootstrapper.ensureReady(makeBrowserWindow());

        const envs = uvSpawnEnvs();
        expect(envs.length).toBeGreaterThan(0);
        for (const env of envs) {
          expect(env.UV_CACHE_DIR).toBe(userCache);
          expect(env.UV_LINK_MODE).toBe("copy");
        }
      } finally {
        delete process.env.UV_CACHE_DIR;
        delete process.env.UV_LINK_MODE;
      }
    });

    it("ensureDirs() 가 UV_CACHE_DIR 경로를 0o700 권한으로 mkdir 한다", async () => {
      delete process.env.UV_CACHE_DIR;
      setupPythonRuntimeSetupSpawns();

      const mkdirCalls: Array<{ path: string; mode: number | undefined }> = [];
      vi.mocked(fsMock.mkdir).mockImplementation(async (target, opts) => {
        const optsObj = (opts as { mode?: number } | undefined) ?? {};
        mkdirCalls.push({ path: String(target), mode: optsObj.mode });
        return undefined;
      });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper({
          pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
        });
        await bootstrapper.ensureReady(makeBrowserWindow());

        const cacheCall = mkdirCalls.find((c) => normalizePathForAssert(c.path) === expectedRuntimePath("uv-cache"));
        expect(cacheCall).toBeDefined();
        expect(cacheCall!.mode).toBe(0o700);
        // LVIS_HOME/<feature>/ 룰: 모든 runtime 하위 디렉토리는 0o700.
        const runtimeRoot = `${expectedRuntimePath()}/`;
        const lvisRuntimeMkdirs = mkdirCalls.filter((c) => normalizePathForAssert(c.path).startsWith(runtimeRoot));
        for (const call of lvisRuntimeMkdirs) {
          expect(call.mode).toBe(0o700);
        }
      } finally {
        vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      }
    });
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

  // ─── issue #717: ~/.lvis/runtime/* file permissions hardening ────────────

  describe("issue #717 — runtime file permission hardening (0o600)", () => {
    it("writeSentinel은 mode: 0o600으로 writeFile을 호출한다", async () => {
      setupPythonRuntimeSetupSpawns();

      const writeFileCalls: Array<{ path: string; opts: unknown }> = [];
      vi.mocked(fsMock.writeFile).mockImplementation(async (target, _data, opts) => {
        writeFileCalls.push({ path: String(target), opts });
        return undefined;
      });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper({
          pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
        });
        await bootstrapper.ensureReady(makeBrowserWindow());

        const sentinelCall = writeFileCalls.find((c) => normalizePathForAssert(c.path).endsWith("/venv/.ready"));
        expect(sentinelCall).toBeDefined();
        expect((sentinelCall!.opts as { mode?: number }).mode).toBe(0o600);
      } finally {
        vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
      }
    });

    it("log()는 mode: 0o600으로 appendFile을 호출한다", async () => {
      setupPythonRuntimeSetupSpawns();

      const appendFileCalls: Array<{ path: string; opts: unknown }> = [];
      vi.mocked(fsMock.appendFile).mockImplementation(async (target, _data, opts) => {
        appendFileCalls.push({ path: String(target), opts });
        return undefined;
      });

      try {
        const bootstrapper = new PythonRuntimeBootstrapper({
          pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
        });
        await bootstrapper.ensureReady(makeBrowserWindow());

        const logCalls = appendFileCalls.filter((c) =>
          normalizePathForAssert(c.path).endsWith("/runtime/logs/setup.log"),
        );
        expect(logCalls.length).toBeGreaterThan(0);
        for (const call of logCalls) {
          expect((call.opts as { mode?: number }).mode).toBe(0o600);
        }
      } finally {
        vi.mocked(fsMock.appendFile).mockResolvedValue(undefined);
      }
    });

    it("materializePackagedUvBinary 실제 파일시스템: 바이너리 mode가 non-Windows에서 0o700(owner-exec)이다", async () => {
      // Skip on Windows — NTFS does not honour Unix mode bits.
      if (process.platform === "win32") return;

      const resourcesPath = mkdtempSync(path.join(tmpdir(), "lvis-perm717-resources-"));
      const uvRuntimeDir = mkdtempSync(path.join(tmpdir(), "lvis-perm717-uv-"));
      const manifestRoot = mkdtempSync(path.join(tmpdir(), "lvis-perm717-plugin-"));
      const manifestPath = path.join(manifestRoot, "plugin.json");
      const lockFilePath = path.join(manifestRoot, "python-requirements.lock");
      const packagedUvDir = path.join(resourcesPath, "uv", `${process.platform}-${process.arch}`);
      const binName = "uv";
      const uvSha = "3105dd1dda985da51e5ea5001f835e2a7bd675ac145aa8779201c8737d72073b";
      const expectedUvBin = path.join(uvRuntimeDir, `${process.platform}-${process.arch}`, uvSha, binName);

      mkdirSync(packagedUvDir, { recursive: true });
      writeFileSync(path.join(packagedUvDir, "uv.gz"), gzipSync(Buffer.from("uv-bin-content")));
      writeFileSync(path.join(packagedUvDir, "uv.meta.json"), JSON.stringify({ binarySha256: uvSha }));
      writeFileSync(manifestPath, JSON.stringify({ python: { managedBy: "lvis-app" } }));
      writeFileSync(lockFilePath, "");

      const originalDefaultApp = (process as { defaultApp?: boolean }).defaultApp;
      const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      (process as { defaultApp?: boolean }).defaultApp = false;
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;

      mockedReadFile.mockResolvedValue(JSON.stringify({ python: { managedBy: "lvis-app" } }));
      mockedAccess.mockImplementation(async (filePath) => {
        const p = normalizePathForAssert(String(filePath));
        if (p.includes(".ready")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        if (normalizePathForAssert(String(filePath)) === normalizePathForAssert(expectedUvBin)) return undefined;
        if (normalizePathForAssert(String(filePath)) === normalizePathForAssert(lockFilePath)) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      mockedSpawn
        .mockReturnValueOnce(makeSpawnMock("uv 0.7.3\n"))
        .mockReturnValueOnce(makeSpawnMock(""))
        .mockReturnValueOnce(makeSpawnMock(""))
        .mockReturnValueOnce(makeSpawnMock("3.12.3\n"));

      try {
        const bootstrapper = new PythonRuntimeBootstrapper({
          pluginManifestPaths: [manifestPath],
          uvRuntimeDir,
        });
        await bootstrapper.ensureReady(makeBrowserWindow());

        // Binary was materialized by writeFileSync + chmodSync (real FS, not mocked).
        expect(existsSync(expectedUvBin)).toBe(true);
        const stat = require("node:fs").statSync(expectedUvBin);
        // Mode bits: 0o700 = owner rwx only (no group/world read or execute).
        // statSync.mode includes file type bits (0o100000 for regular file).
        const permBits = stat.mode & 0o777;
        expect(permBits).toBe(0o700);
      } finally {
        (process as { defaultApp?: boolean }).defaultApp = originalDefaultApp;
        (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
        rmSync(resourcesPath, { recursive: true, force: true });
        rmSync(uvRuntimeDir, { recursive: true, force: true });
        rmSync(manifestRoot, { recursive: true, force: true });
      }
    });

    it("repairLegacyFileModes chmods existing .ready and setup.log to 0o600 on every boot", async () => {
      // Pre-fix #717 follow-up: existing files created with default umask
      // 0o644 stayed world-readable forever because mode-on-write only
      // applies to NEW files. The boot-time chmod sweep migrates them.
      const chmodCalls: Array<{ target: string; mode: number }> = [];
      vi.mocked(fsMock.chmod).mockImplementation(async (target, mode) => {
        chmodCalls.push({ target: String(target), mode: Number(mode) });
      });
      mockedAccess.mockResolvedValue(undefined); // sentinel exists — skip setup
      mockedSpawn.mockReturnValue(makeSpawnMock(""));

      const bootstrapper = new PythonRuntimeBootstrapper();
      await bootstrapper.ensureReady(makeBrowserWindow());

      // On non-Windows, sweep should have called chmod for both targets
      // with mode 0o600. Skip assertion entirely on Windows where the
      // production code early-returns from repairLegacyFileModes.
      if (process.platform !== "win32") {
        const sentinelChmod = chmodCalls.find((c) => c.target.includes(".ready"));
        const logChmod = chmodCalls.find((c) => c.target.includes("setup.log"));
        expect(sentinelChmod).toBeDefined();
        expect(sentinelChmod?.mode).toBe(0o600);
        expect(logChmod).toBeDefined();
        expect(logChmod?.mode).toBe(0o600);
      } else {
        expect(chmodCalls.length).toBe(0);
      }
    });

    it("repairLegacyFileModes silently skips ENOENT (first install — file not yet created)", async () => {
      if (process.platform === "win32") return;
      vi.mocked(fsMock.chmod).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      mockedAccess.mockResolvedValue(undefined);
      mockedSpawn.mockReturnValue(makeSpawnMock(""));

      const bootstrapper = new PythonRuntimeBootstrapper();
      // Should NOT throw — ENOENT is expected on first install.
      await expect(bootstrapper.ensureReady(makeBrowserWindow())).resolves.toBeDefined();
    });

    it("repairLegacyFileModes also chmods runtime parent dirs to 0o700 (Round 3 — directory mode migration)", async () => {
      // Pre-Round-3: directories created by older installs at default 0o755
      // were world-traversable (directory listing only, no content). The
      // sweep now tightens LVIS_RUNTIME_DIR / VENV_DIR / LOGS_DIR /
      // UV_CACHE_DIR_PATH to 0o700 alongside the file targets.
      if (process.platform === "win32") return;
      const chmodCalls: Array<{ target: string; mode: number }> = [];
      vi.mocked(fsMock.chmod).mockImplementation(async (target, mode) => {
        chmodCalls.push({ target: String(target), mode: Number(mode) });
      });
      mockedAccess.mockResolvedValue(undefined);
      mockedSpawn.mockReturnValue(makeSpawnMock(""));

      const bootstrapper = new PythonRuntimeBootstrapper();
      await bootstrapper.ensureReady(makeBrowserWindow());

      const dirChmod = (suffix: string) =>
        chmodCalls.find((c) => c.target.endsWith(suffix) && c.mode === 0o700);
      expect(dirChmod("/runtime")).toBeDefined();
      expect(dirChmod("/runtime/venv")).toBeDefined();
      expect(dirChmod("/runtime/logs")).toBeDefined();
      expect(dirChmod("/runtime/uv-cache")).toBeDefined();
    });

    it("repairLegacyUvBinaries chmods all uv binaries under uvRuntimeDir to 0o700", async () => {
      // Pre-Round-3: legacy materialized uv binaries lived at 0o755
      // (world-read+exec). The sha-keyed path layout
      // `<uvRuntimeDir>/<arch>/<sha>/uv` is enumerated and each chmod'd to
      // 0o700.
      if (process.platform === "win32") return;
      const chmodCalls: Array<{ target: string; mode: number }> = [];
      vi.mocked(fsMock.chmod).mockImplementation(async (target, mode) => {
        chmodCalls.push({ target: String(target), mode: Number(mode) });
      });
      // Simulate two arch dirs each with one sha-keyed binary.
      // Cast through `unknown` rather than `as never` — readdir's overload
      // union (string[] | Buffer[] | Dirent[]) makes vitest's mock typing
      // awkward; the unknown cast preserves the "I'm narrowing the
      // overload" intent without nuking the type system.
      vi.mocked(fsMock.readdir).mockImplementation((async (dirPath: string) => {
        const p = String(dirPath);
        if (p.endsWith("/runtime/uv")) return ["linux-arm64", "linux-x64"];
        if (p.endsWith("linux-arm64")) return ["sha-aaa"];
        if (p.endsWith("linux-x64")) return ["sha-bbb"];
        return [];
      }) as unknown as typeof fsMock.readdir);
      mockedAccess.mockResolvedValue(undefined);
      mockedSpawn.mockReturnValue(makeSpawnMock(""));

      const bootstrapper = new PythonRuntimeBootstrapper();
      await bootstrapper.ensureReady(makeBrowserWindow());

      const uvChmod = (suffix: string) =>
        chmodCalls.find((c) => c.target.endsWith(suffix) && c.mode === 0o700);
      expect(uvChmod("/runtime/uv/linux-arm64/sha-aaa/uv")).toBeDefined();
      expect(uvChmod("/runtime/uv/linux-x64/sha-bbb/uv")).toBeDefined();
    });

    it("repairLegacyUvBinaries returns silently when uvRuntimeDir does not exist", async () => {
      // Pre-first-install: no uv binaries yet. ENOENT on top-level readdir
      // returns without logging.
      if (process.platform === "win32") return;
      vi.mocked(fsMock.readdir).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      mockedAccess.mockResolvedValue(undefined);
      mockedSpawn.mockReturnValue(makeSpawnMock(""));

      const bootstrapper = new PythonRuntimeBootstrapper();
      await expect(bootstrapper.ensureReady(makeBrowserWindow())).resolves.toBeDefined();
    });
  });
});

// ─── ASRT worker spawn wiring (Tier-A worker egress) ──────────────────────────

describe("PythonRuntimeBootstrapper — ASRT worker spawn gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    asrtState.active = false;
    mockWrapWorkerCommand.mockImplementation(async (command: string) => ({
      argv: ["/bin/sh", "-c", command],
      env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://localhost:8080" } as NodeJS.ProcessEnv,
    }));
    vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsMock.appendFile).mockResolvedValue(undefined);
    vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsMock.chmod).mockResolvedValue(undefined);
    mockedReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    vi.mocked(fsMock.readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    asrtState.active = false;
  });

  it("DEFAULT-OFF: the gate ships inactive (wrapWorkerCommand is never called on a fresh boot)", async () => {
    // No flip — this asserts the shipped default: a worker spawn does NOT route
    // through ASRT unless the gate was explicitly turned on at boot.
    expect(asrtState.active).toBe(false);
    mockedAccess.mockResolvedValue(undefined); // .ready sentinel present → no spawn
    const bootstrapper = new PythonRuntimeBootstrapper();
    await bootstrapper.ensureReady(makeBrowserWindow());
    expect(mockWrapWorkerCommand).not.toHaveBeenCalled();
  });

  it("gate OFF: uv/python spawn via plain spawn (unchanged), never wrapWorkerCommand", async () => {
    asrtState.active = false;
    setupPythonRuntimeSetupSpawns();
    const bootstrapper = new PythonRuntimeBootstrapper({
      pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
    });
    await bootstrapper.ensureReady(makeBrowserWindow());
    // plain spawn used (uv install/venv/sync + python verify = 4 spawns).
    expect(mockedSpawn).toHaveBeenCalled();
    expect(mockWrapWorkerCommand).not.toHaveBeenCalled();
    // First spawn is the raw uv binary, not a wrapped shell (no shell:false set).
    const firstArgs = mockedSpawn.mock.calls[0];
    expect((firstArgs?.[2] as { shell?: boolean } | undefined)?.shell).toBeUndefined();
  });

  it("gate ON: uv/python spawn route through wrapWorkerCommand with the plugin's strict allow-list", async () => {
    asrtState.active = true;
    setupPythonRuntimeSetupSpawns();
    const bootstrapper = new PythonRuntimeBootstrapper({
      pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
      workerSandbox: { pluginId: "lvis-plugin-lge-api", allowedDomains: ["api.lge.example"] },
    });
    await bootstrapper.ensureReady(makeBrowserWindow());

    // Every worker spawn was wrapped.
    expect(mockWrapWorkerCommand).toHaveBeenCalled();
    // The network policy fed the plugin's declared allow-list under strict hard-deny.
    const opts = mockWrapWorkerCommand.mock.calls[0]?.[1] as
      | { network?: { allowedDomains: string[]; strictAllowlist?: boolean } }
      | undefined;
    expect(opts?.network?.allowedDomains).toEqual(["api.lge.example"]);
    expect(opts?.network?.strictAllowlist).toBe(true);
    // Host spawned the wrapped argv with shell:false.
    const spawnOpts = mockedSpawn.mock.calls[0]?.[2] as { shell?: boolean } | undefined;
    expect(spawnOpts?.shell).toBe(false);
    // Per-command cleanup ran after the spawn settled.
    expect(mockCleanupAsrt).toHaveBeenCalled();
  });

  it("gate ON without a worker manifest policy: deny-all egress (empty allow-list)", async () => {
    asrtState.active = true;
    setupPythonRuntimeSetupSpawns();
    const bootstrapper = new PythonRuntimeBootstrapper({
      pluginManifestPaths: ["/installed/local-indexer/plugin.json"],
    }); // no workerSandbox
    await bootstrapper.ensureReady(makeBrowserWindow());
    const opts = mockWrapWorkerCommand.mock.calls[0]?.[1] as
      | { network?: { allowedDomains: string[]; strictAllowlist?: boolean } }
      | undefined;
    expect(opts?.network?.allowedDomains).toEqual([]);
    expect(opts?.network?.strictAllowlist).toBe(true);
  });
});
