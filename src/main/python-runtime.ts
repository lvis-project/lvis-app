/**
 * PythonRuntimeBootstrapper — host-managed plugin Python runtime coordinator
 *
 * Host-managed Python plugins use this coordinator during plugin start
 * preparation. The app boot path wires the coordinator only; packaged uv
 * materialization, Python acquisition, and dependency sync happen lazily when
 * a plugin with an accessible lockfile needs a non-ready runtime.
 *
 * Plugins that need Python dependencies must ship their lockfile in the
 * installed plugin/manifest directory (or declare a relative lockfile path in
 * plugin.json). The host must not reach into sibling plugin source checkouts.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { createLogger } from "../lib/logger.js";
import { resolvePluginPaths } from "../plugins/plugin-paths.js";
import { readPluginRegistry, resolveManifestPathsFromRegistry } from "../plugins/registry.js";
import { getSandboxRunner } from "../permissions/sandbox-runner.js";
import { resolveUvTarget, type UvTarget } from "../../scripts/uv-targets.mjs";
import { lvisHome } from "../shared/lvis-home.js";
import { trackManagedChildProcess } from "./managed-child-processes.js";
import { resolveBundledUvBinaryPath } from "./uv-runtime.js";
const log = createLogger("python-runtime");

// ─── 타입 ────────────────────────────────────────────

export type BootstrapPhase =
  | "pending"
  | "installing-python"
  | "installing-deps"
  | "verifying"
  | "ready"
  | "error";

export interface BootstrapStatus {
  phase: BootstrapPhase;
  msg: string;
  pct: number;
}

export interface RuntimeResult {
  pythonPath: string;
  venvPath: string;
}

interface ReadySentinel {
  at: string;
  uvVersion: string;
  pythonVersion: string;
}

// ─── 상수 ────────────────────────────────────────────

const LVIS_RUNTIME_DIR = path.join(lvisHome(), "runtime");
// Co-locate uv cache with the venv so hardlinks from cache → site-packages stay
// on the same physical volume. NTFS hardlinks fail cross-volume with EXDEV
// (issue #713) when ~/.lvis and %LOCALAPPDATA% live on different drives via
// junction / OneDrive redirect / profile migration.

// requirements.lock 위치: 설치된 플러그인 manifest 디렉토리 또는 명시 선언.
const LOCK_FILE_RESOURCE_NAME = "python-requirements.lock";
const runtimeSetupLocks = new Map<string, Promise<RuntimeResult>>();

export interface PythonRuntimeBootstrapperOptions {
  /**
   * Test/embedding injection: absolute plugin.json paths whose directory may
   * contain the Python requirements lockfile.
   */
  pluginManifestPaths?: string[];
  /** Test/embedding injection: plugin root directories to scan directly. */
  pluginRoots?: string[];
  /** Registry to inspect for installed plugin manifest paths. */
  registryPath?: string;
  /** Mostly for tests; defaults to python-requirements.lock. */
  lockFileName?: string;
  /** Mostly for tests; defaults to ~/.lvis/runtime/uv. */
  uvRuntimeDir?: string;
  /** Runtime root. Host-managed Python envs use ~/.lvis/runtime/python-envs/<lockHash>. */
  runtimeDir?: string;
  /** Exact lockfile selected by a plugin prepare path. */
  lockFilePath?: string;
  /** Force uv pip sync even when a ready sentinel exists. */
  forceSetup?: boolean;
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

// ─── PythonRuntimeBootstrapper ───────────────────────

export class PythonRuntimeBootstrapper {
  private mainWindow: BrowserWindow | null = null;

  constructor(private readonly options: PythonRuntimeBootstrapperOptions = {}) {}

  private runtimeDir(): string {
    return this.options.runtimeDir ?? LVIS_RUNTIME_DIR;
  }

  private venvDir(): string {
    return path.join(this.runtimeDir(), "venv");
  }

  private pythonInstallDir(): string {
    return path.join(this.runtimeDir(), "python");
  }

  private uvCacheDir(): string {
    return path.join(this.runtimeDir(), "uv-cache");
  }

  private logsDir(): string {
    return path.join(this.runtimeDir(), "logs");
  }

  private setupLogPath(): string {
    return path.join(this.logsDir(), "setup.log");
  }

  private readySentinelPath(): string {
    return path.join(this.venvDir(), ".ready");
  }

  /**
   * Python 런타임이 준비될 때까지 기다린다.
   * .ready sentinel이 있으면 즉시 resolve (두 번째 이후 부팅 < 50ms).
   */
  async ensureReady(mainWindow: BrowserWindow): Promise<RuntimeResult> {
    this.mainWindow = mainWindow;
    this.getCurrentUvTarget();
    const pythonPath = this.getPythonPath();
    const result: RuntimeResult = { pythonPath, venvPath: this.venvDir() };

    // Repair file modes on existing files (#717 follow-up). Pre-fix, files
    // created with default umask 0o644 are world-readable on shared corp
    // hosts. The mode-on-write hardening only affects NEW writes; existing
    // installs need a one-shot chmod sweep on each boot to migrate. Idempotent
    // (chmod to already-correct mode is a no-op). Best-effort — failure must
    // not block boot. Windows: fs.chmod is a no-op for mode bits, harmless.
    await this.repairLegacyFileModes();

    return this.ensureSetupOnce(result);
  }

  /**
   * Prepare the runtime after a plugin is installed in the current session.
   * Returns null when the manifest has no accessible lockfile so non-Python
   * plugins do not turn install into a Python bootstrap attempt.
   */
  async ensureReadyForPluginManifest(
    manifestPath: string,
    mainWindow: BrowserWindow,
  ): Promise<RuntimeResult | null> {
    const lockFileName = this.options.lockFileName ?? LOCK_FILE_RESOURCE_NAME;
    const candidates = await this.lockCandidatesFromManifest(manifestPath, lockFileName);
    let selectedLockFile: string | undefined;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        selectedLockFile = candidate;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!selectedLockFile) {
      await this.log(`[python-runtime] plugin has no accessible Python lockfile — skip runtime prepare (${manifestPath})`);
      return null;
    }

    const runtimeDir = await this.runtimeDirForLockFile(selectedLockFile);
    const bootstrapper = new PythonRuntimeBootstrapper({
      ...this.options,
      pluginManifestPaths: [
        manifestPath,
        ...(this.options.pluginManifestPaths ?? []).filter((p) => p !== manifestPath),
      ],
      lockFilePath: selectedLockFile,
      runtimeDir,
      forceSetup: false,
    });
    return bootstrapper.ensureReady(mainWindow);
  }

  // ─── private: sentinel ────────────────────────────

  private async checkSentinel(): Promise<boolean> {
    try {
      await fs.access(this.readySentinelPath());
      return true;
    } catch {
      return false;
    }
  }

  private async writeSentinel(uvVersion: string, pythonVersion: string): Promise<void> {
    const data: ReadySentinel = {
      at: new Date().toISOString(),
      uvVersion,
      pythonVersion,
    };
    await fs.writeFile(this.readySentinelPath(), JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  // ─── private: setup pipeline ─────────────────────

  private async ensureSetupOnce(result: RuntimeResult): Promise<RuntimeResult> {
    const lockKey = path.resolve(this.runtimeDir());
    const existing = runtimeSetupLocks.get(lockKey);
    if (existing) return await existing;

    const setupTask = this.setupIfStillNeeded(result);
    runtimeSetupLocks.set(lockKey, setupTask);
    try {
      return await setupTask;
    } finally {
      if (runtimeSetupLocks.get(lockKey) === setupTask) {
        runtimeSetupLocks.delete(lockKey);
      }
    }
  }

  private async setupIfStillNeeded(result: RuntimeResult): Promise<RuntimeResult> {
    if (!this.options.forceSetup && await this.checkSentinel()) {
      this.sendStatus({ phase: "ready", msg: "Python 런타임 준비 완료 (캐시)", pct: 100 });
      await this.log("[python-runtime] .ready sentinel 확인 — skip setup");
      return result;
    }

    await this.setup();
    return result;
  }

  private async setup(): Promise<void> {
    await this.ensureDirs();

    const uvBin = this.getUvBinaryPath();
    await this.log(`[python-runtime] uv binary: ${uvBin}`);

    // Step 1: uv 바이너리 존재 확인
    try {
      await fs.access(uvBin);
    } catch {
      throw new Error(
        `uv binary를 찾을 수 없습니다: ${uvBin}\n` +
        `"npm run postinstall" 또는 "node scripts/fetch-uv.mjs"를 먼저 실행하세요.`
      );
    }

    // Step 2: Python 3.12 설치
    this.sendStatus({ phase: "installing-python", msg: "Python 3.12 설치 중...", pct: 10 });
    await this.log("[python-runtime] Step 1: uv python install 3.12");
    const uvVersion = await this.runUv(uvBin, [
      "python", "install", "3.12",
    ], {
      UV_PYTHON_INSTALL_DIR: this.pythonInstallDir(),
    });

    // Step 3: venv 생성
    this.sendStatus({ phase: "installing-python", msg: "Python venv 생성 중...", pct: 30 });
    await this.log("[python-runtime] Step 2: uv venv");
    await this.runUv(uvBin, [
      "venv", this.venvDir(), "--python", "3.12",
    ], {
      UV_PYTHON_INSTALL_DIR: this.pythonInstallDir(),
    });

    // Step 4: pip sync (requirements.lock)
    // uv 0.7.3 이후 `pip sync`는 lock 파일을 받아 그대로 동기화하므로 `--frozen`은
    // 받지 않음 (uv 0.7.x: error: unexpected argument '--frozen'). lock 파일 자체가
    // pinning 역할이라 의미적으로도 redundant.
    this.sendStatus({ phase: "installing-deps", msg: "의존성 설치 중 (최초 1회)...", pct: 40 });
    await this.log("[python-runtime] Step 3: uv pip sync");
    const lockFile = await this.findLockFile();
    await this.runUv(uvBin, [
      "pip", "sync", lockFile,
      "--python", this.getPythonPath(),
    ], {
      UV_PYTHON_INSTALL_DIR: this.pythonInstallDir(),
    });

    // Step 5: import 검증
    this.sendStatus({ phase: "verifying", msg: "설치 검증 중...", pct: 85 });
    await this.log("[python-runtime] Step 4: import verification");
    const pythonVersion = await this.verifyImports();

    // Step 6: sentinel 기록
    const uvVersionStr = uvVersion.trim().split("\n")[0] ?? "unknown";
    await this.writeSentinel(uvVersionStr, pythonVersion);
    await this.log(`[python-runtime] .ready sentinel 기록 완료 — python: ${pythonVersion}`);

    this.sendStatus({ phase: "ready", msg: "Python 런타임 준비 완료", pct: 100 });
  }

  // ─── private: Python path ─────────────────────────

  getPythonPath(): string {
    if (process.platform === "win32") {
      return path.join(this.venvDir(), "Scripts", "python.exe");
    }
    return path.join(this.venvDir(), "bin", "python");
  }

  // ─── private: uv binary path ──────────────────────

  private getUvBinaryPath(): string {
    return resolveBundledUvBinaryPath({
      requireDevBinary: false,
      uvRuntimeDir: this.options.uvRuntimeDir,
    });
  }

  private getCurrentUvTarget(): UvTarget {
    return resolveUvTarget(process.platform, process.arch);
  }

  // ─── private: lock file 위치 ──────────────────────

  private async lockCandidatesFromManifest(
    manifestPath: string,
    lockFileName: string,
  ): Promise<string[]> {
    const manifestDir = path.dirname(manifestPath);
    const candidates: string[] = [];
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as {
        capabilities?: unknown;
        python?: { requirementsLock?: unknown };
        pythonRequirementsLock?: unknown;
        runtime?: { python?: { requirementsLock?: unknown } };
        config?: { pythonRequirementsLock?: unknown };
      };
      const declared =
        typeof manifest.python?.requirementsLock === "string"
          ? manifest.python.requirementsLock
          : typeof manifest.pythonRequirementsLock === "string"
          ? manifest.pythonRequirementsLock
          : typeof manifest.runtime?.python?.requirementsLock === "string"
            ? manifest.runtime.python.requirementsLock
            : typeof manifest.config?.pythonRequirementsLock === "string"
              ? manifest.config.pythonRequirementsLock
              : undefined;
      if (declared && declared.length > 0) {
        if (path.isAbsolute(declared)) {
          await this.log(`[python-runtime] plugin manifest lockfile declaration rejected (absolute path): ${manifestPath}`);
        } else {
          const resolved = path.resolve(manifestDir, declared);
          if (isWithinDirectory(resolved, manifestDir)) {
            candidates.push(resolved);
          } else {
            await this.log(`[python-runtime] plugin manifest lockfile declaration rejected (outside plugin directory): ${manifestPath}`);
          }
        }
      }
    } catch (err) {
      await this.log(`[python-runtime] plugin manifest lockfile declaration unreadable (${manifestPath}): ${(err as Error).message}`);
    }
    candidates.push(path.join(manifestDir, lockFileName));
    return candidates;
  }

  private async collectLockFileCandidates(): Promise<string[]> {
    const lockFileName = this.options.lockFileName ?? LOCK_FILE_RESOURCE_NAME;
    const candidates: string[] = [];

    for (const manifestPath of this.options.pluginManifestPaths ?? []) {
      candidates.push(...await this.lockCandidatesFromManifest(manifestPath, lockFileName));
    }
    for (const pluginRoot of this.options.pluginRoots ?? []) {
      candidates.push(path.join(pluginRoot, lockFileName));
    }

    const registryPath = this.options.registryPath ?? resolvePluginPaths().registryPath;
    try {
      const registry = await readPluginRegistry(registryPath);
      for (const manifestPath of resolveManifestPathsFromRegistry(registryPath, registry.plugins)) {
        candidates.push(...await this.lockCandidatesFromManifest(manifestPath, lockFileName));
      }
    } catch (err) {
      await this.log(`[python-runtime] registry lockfile discovery skipped (${registryPath}): ${(err as Error).message}`);
    }

    return [...new Set(candidates)];
  }

  private async findLockFile(): Promise<string> {
    if (this.options.lockFilePath) return this.options.lockFilePath;
    const candidates = await this.collectLockFileCandidates();
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
    throw new Error(
      `python-requirements.lock 파일을 찾을 수 없습니다.\n` +
      `검색 경로:\n${candidates.length > 0 ? candidates.map((candidate) => `- ${candidate}`).join("\n") : "- (없음)"}`
    );
  }

  private async runtimeDirForLockFile(lockFilePath: string): Promise<string> {
    const lockFile = await fs.readFile(lockFilePath);
    const lockBytes = Buffer.isBuffer(lockFile) ? lockFile : Buffer.from(lockFile);
    const lockHash = createHash("sha256").update(lockBytes).digest("hex").slice(0, 24);
    const uvTarget = this.getCurrentUvTarget();
    return path.join(LVIS_RUNTIME_DIR, "python-envs", `${uvTarget.dir}-py312-${lockHash}`);
  }

  // ─── private: 실행 헬퍼 ──────────────────────────

  private runUv(
    uvBin: string,
    args: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Whitelist-only env — only the uv subprocess needs PATH/HOME/locale.
      // uv only needs PATH + HOME + locale + tmp dirs. Callers supply
      // UV_PYTHON_INSTALL_DIR via extraEnv.
      const allowedEnvKeys = new Set<string>([
        "PATH",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "NODE_ENV",
        // Issue #713 escape hatches: let users override cache location and
        // hardlink mode via OS env when their drive layout still trips uv
        // (e.g. ~/.lvis itself bridging volumes via subpath junctions).
        "UV_CACHE_DIR",
        "UV_LINK_MODE",
      ]);
      const env: NodeJS.ProcessEnv = {};
      for (const key of allowedEnvKeys) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, extraEnv);
      // uv가 interactive prompt를 띄우지 않도록
      env.UV_NO_PROGRESS = "1";
      // Default uv cache co-located with the LVIS runtime; user-provided
      // UV_CACHE_DIR (via the whitelist above or extraEnv) takes precedence.
      if (env.UV_CACHE_DIR === undefined) {
        env.UV_CACHE_DIR = this.uvCacheDir();
      }

      // §691 PR-A4: SandboxRunner adoption gate for uv spawn.
      // When LVIS_SANDBOX_ENABLED=1 and a runner is registered, log the
      // intent. Full adoption is deferred until SandboxedProcess exposes a
      // Node.js-compatible stream API (SandboxedProcess uses WHATWG
      // ReadableStream; runUv uses .on("data") event emitter pattern).
      // Tracking: #691 spawn-path follow-up.
      if (process.env.LVIS_SANDBOX_ENABLED === "1") {
        const runner = getSandboxRunner(process.platform);
        if (runner) {
          // Runner is available — future: wrap spawn via runner.spawn()
          // once SandboxedProcess stream compat is resolved.
          void this.log("[python-runtime] LVIS_SANDBOX_ENABLED: uv runner available (full adoption pending stream compat)");
        }
      }

      const proc = spawn(uvBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      trackManagedChildProcess(proc, { label: "python-runtime:uv" });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        void this.log(`[uv stdout] ${text.trimEnd()}`);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        void this.log(`[uv stderr] ${text.trimEnd()}`);
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new Error(`uv binary 실행 실패 (ENOENT): ${uvBin}`));
        } else {
          reject(new Error(`uv 실행 오류: ${err.message}`));
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `uv 명령 실패 (exit ${code}): uv ${args.join(" ")}\n` +
              `stderr: ${stderr.slice(-1000)}`
            )
          );
        }
      });
    });
  }

  private runPython(pythonBin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Whitelist-only env — same rationale as runUv(). Only OS-essential
      // variables propagate into the verification subprocess so that no
      // host secrets (OPENAI_API_KEY, AWS creds, …) are leaked.
      const allowedEnvKeys = new Set<string>([
        "PATH",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "NODE_ENV",
      ]);
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const key of allowedEnvKeys) {
        const value = process.env[key];
        if (value !== undefined) safeEnv[key] = value;
      }
      const proc = spawn(pythonBin, args, { env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
      trackManagedChildProcess(proc, { label: "python-runtime:python" });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new Error(`Python binary 실행 실패 (ENOENT): ${pythonBin}`));
        } else {
          reject(new Error(`Python 실행 오류: ${err.message}`));
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(
            new Error(
              `Python 검증 실패 (exit ${code})\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`
            )
          );
        }
      });
    });
  }

  // ─── private: import 검증 ─────────────────────────

  private async verifyImports(): Promise<string> {
    const pythonBin = this.getPythonPath();
    const verifyScript = [
      "import sys",
      "print(sys.version.split()[0])",
    ].join("; ");

    const version = await this.runPython(pythonBin, ["-c", verifyScript]).catch((err: Error) => {
      throw new Error(
        `Python 런타임 검증 실패.\n` +
        `원인: ${err.message}`
      );
    });

    return version;
  }

  // ─── private: IPC 상태 발행 ───────────────────────

  private sendStatus(status: BootstrapStatus): void {
    try {
      this.mainWindow?.webContents.send("bootstrap.status", status);
    } catch {
      // 윈도우가 아직 준비되지 않은 경우 무시
    }
  }

  // ─── private: 로그 ───────────────────────────────

  private async ensureDirs(): Promise<void> {
    // ~/.lvis/<feature>/ namespace rule: directories owner-only (0o700).
    await fs.mkdir(this.runtimeDir(), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.logsDir(), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.pythonInstallDir(), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.uvCacheDir(), { recursive: true, mode: 0o700 });
  }

  /**
   * One-shot chmod sweep for files created by older installs (umask default
   * 0o644). Idempotent — chmod to already-correct mode is a no-op. Skipped
   * on Windows where mode bits are meaningless. Each chmod is best-effort;
   * failure for one file does not skip the others.
   */
  private async repairLegacyFileModes(): Promise<void> {
    if (process.platform === "win32") return;

    // Files: 0o600 (owner-only rw)
    const fileTargets: Array<{ path: string; mode: number }> = [
      { path: this.readySentinelPath(), mode: 0o600 },
      { path: this.setupLogPath(), mode: 0o600 },
    ];
    // Directories: 0o700 (owner-only rwx). Pre-fix dirs created at default
    // 0o755 are world-traversable — minor info leak (directory listing only,
    // not contents), but tightening matches the namespace rule.
    const dirTargets: Array<{ path: string; mode: number }> = [
      { path: this.runtimeDir(), mode: 0o700 },
      { path: this.venvDir(), mode: 0o700 },
      { path: this.logsDir(), mode: 0o700 },
      { path: this.uvCacheDir(), mode: 0o700 },
    ];

    for (const { path: target, mode } of [...fileTargets, ...dirTargets]) {
      try {
        await fs.chmod(target, mode);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // first install — entry not yet created
        log.warn(`repairLegacyFileModes failed for ${target}: ${(err as Error).message}`);
      }
    }

    // Materialized uv binaries: walk `<uvRuntimeDir>/<arch>/<sha>/<bin>`
    // and chmod each to 0o700. Pre-fix legacy installs left these at 0o755
    // (world-read+exec). Owner-only is the contract going forward.
    const uvRuntimeDir = this.options.uvRuntimeDir ?? path.join(this.runtimeDir(), "uv");
    await this.repairLegacyUvBinaryModes(uvRuntimeDir);
  }

  /**
   * Walk the materialized uv binary tree and chmod each binary to 0o700.
   * The binary basename is derived from `resolveUvTarget(process.platform,
   * process.arch).bin` — currently `"uv"` on POSIX, `"uv.exe"` on Windows.
   * Note: this method only runs on POSIX (caller early-returns on win32),
   * but resolving the basename programmatically guards against future
   * cross-platform symmetry refactors silently missing `uv.exe`.
   */
  private async repairLegacyUvBinaryModes(uvRuntimeDir: string): Promise<void> {
    const binBasename = resolveUvTarget(process.platform, process.arch).bin;
    let archDirs: string[];
    try {
      archDirs = await fs.readdir(uvRuntimeDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log.warn(`repairLegacyUvBinaryModes readdir(${uvRuntimeDir}) failed: ${(err as Error).message}`);
      return;
    }
    for (const arch of archDirs) {
      const archPath = path.join(uvRuntimeDir, arch);
      let shaDirs: string[];
      try {
        shaDirs = await fs.readdir(archPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // Parity with outer warn — pre-fix this catch was silent and a
          // permission-denied arch dir disappeared without trace.
          log.warn(`repairLegacyUvBinaryModes readdir(${archPath}) failed: ${(err as Error).message}`);
        }
        continue;
      }
      for (const sha of shaDirs) {
        const binPath = path.join(archPath, sha, binBasename);
        try {
          await fs.chmod(binPath, 0o700);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue;
          log.warn(`repairLegacyUvBinaryModes chmod(${binPath}) failed: ${(err as Error).message}`);
        }
      }
    }
  }

  private async log(msg: string): Promise<void> {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      await fs.mkdir(this.logsDir(), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.setupLogPath(), line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // 로그 실패는 무시 (non-fatal)
    }
    log.info(msg);
  }
}
