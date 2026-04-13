/**
 * PythonRuntimeBootstrapper — §4.2 Step 0 (Phase 1)
 *
 * uv standalone binary로 Python 3.12 venv를 자동 셋업한다.
 * 사용자 PC에 Python을 직접 설치하지 않음.
 * 첫 부팅에만 실행 (sentinel 확인 → 이후 즉시 skip).
 *
 * INTEGRATION NOTE for Agent 4 (Plugin Integrator):
 *
 * In /Users/ken/workspace/GIT/github/lvis-project/lvis-app/src/boot.ts bootstrap():
 *   1. Import: import { PythonRuntimeBootstrapper } from "./main/python-runtime.js";
 *   2. As the FIRST step (before SettingsService init), add:
 *        const pythonRuntime = new PythonRuntimeBootstrapper();
 *        const { pythonPath, venvPath } = await pythonRuntime.ensureReady(mainWindow);
 *   3. Pass `pythonPath` to LvisPageIndexPlugin via configOverrides:
 *        configOverrides["lvis-plugin-pageindex"] = { pythonExecutable: pythonPath, ... };
 *   4. The PageIndexPlugin's pageIndexPlugin.ts must use this path instead of "python3".
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { BrowserWindow } from "electron";

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

const LVIS_RUNTIME_DIR = path.join(os.homedir(), ".lvis", "runtime");
const VENV_DIR = path.join(LVIS_RUNTIME_DIR, "venv");
const PYTHON_INSTALL_DIR = path.join(LVIS_RUNTIME_DIR, "python");
const LOGS_DIR = path.join(LVIS_RUNTIME_DIR, "logs");
const SETUP_LOG = path.join(LOGS_DIR, "setup.log");
const READY_SENTINEL = path.join(VENV_DIR, ".ready");

// requirements.lock 위치: 번들된 경우 Resources/, 개발 환경은 플러그인 repo
const LOCK_FILE_RESOURCE_NAME = "python-requirements.lock";

// ─── PythonRuntimeBootstrapper ───────────────────────

export class PythonRuntimeBootstrapper {
  private mainWindow: BrowserWindow | null = null;

  /**
   * Python 런타임이 준비될 때까지 기다린다.
   * .ready sentinel이 있으면 즉시 resolve (두 번째 이후 부팅 < 50ms).
   */
  async ensureReady(mainWindow: BrowserWindow): Promise<RuntimeResult> {
    this.mainWindow = mainWindow;

    const pythonPath = this.getPythonPath();
    const result: RuntimeResult = { pythonPath, venvPath: VENV_DIR };

    // sentinel 확인
    const sentinelExists = await this.checkSentinel();
    if (sentinelExists) {
      this.sendStatus({ phase: "ready", msg: "Python 런타임 준비 완료 (캐시)", pct: 100 });
      await this.log("[python-runtime] .ready sentinel 확인 — skip setup");
      return result;
    }

    // 첫 부팅 셋업
    await this.setup();
    return result;
  }

  // ─── private: sentinel ────────────────────────────

  private async checkSentinel(): Promise<boolean> {
    try {
      await fs.access(READY_SENTINEL);
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
    await fs.writeFile(READY_SENTINEL, JSON.stringify(data, null, 2), "utf8");
  }

  // ─── private: setup pipeline ─────────────────────

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
      UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
    });

    // Step 3: venv 생성
    this.sendStatus({ phase: "installing-python", msg: "Python venv 생성 중...", pct: 30 });
    await this.log("[python-runtime] Step 2: uv venv");
    await this.runUv(uvBin, [
      "venv", VENV_DIR, "--python", "3.12",
    ], {
      UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
    });

    // Step 4: pip sync (requirements.lock)
    this.sendStatus({ phase: "installing-deps", msg: "의존성 설치 중 (최초 1회)...", pct: 40 });
    await this.log("[python-runtime] Step 3: uv pip sync --frozen");
    const lockFile = await this.findLockFile();
    await this.runUv(uvBin, [
      "pip", "sync", "--frozen", lockFile,
      "--python", this.getPythonPath(),
    ], {
      UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
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
      return path.join(VENV_DIR, "Scripts", "python.exe");
    }
    return path.join(VENV_DIR, "bin", "python");
  }

  // ─── private: uv binary path ──────────────────────

  private getUvBinaryPath(): string {
    const platform = process.platform;
    const arch = process.arch;

    const platformDir = this.resolvePlatformDir(platform, arch);
    const binName = platform === "win32" ? "uv.exe" : "uv";

    // 프로덕션: process.resourcesPath (Electron 번들)
    const resourcesPath = process.resourcesPath;
    if (resourcesPath) {
      return path.join(resourcesPath, "uv", platformDir, binName);
    }

    // 개발 환경 fallback: __dirname 기준
    // dist/src/main/ → 프로젝트 루트/resources/uv/...
    const devResourcesPath = path.join(__dirname, "..", "..", "..", "resources", "uv");
    return path.join(devResourcesPath, platformDir, binName);
  }

  private resolvePlatformDir(platform: string, arch: string): string {
    if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
    if (platform === "darwin" && arch === "x64") return "darwin-x64";
    if (platform === "win32" && arch === "x64") return "win32-x64";
    if (platform === "linux" && arch === "x64") return "linux-x64";
    if (platform === "linux" && arch === "arm64") return "linux-arm64";
    throw new Error(`지원하지 않는 플랫폼/아키텍처: ${platform}/${arch}`);
  }

  // ─── private: lock file 위치 ──────────────────────

  private async findLockFile(): Promise<string> {
    // 프로덕션: Electron Resources 번들
    const resourcesPath = process.resourcesPath;
    if (resourcesPath) {
      const bundled = path.join(resourcesPath, LOCK_FILE_RESOURCE_NAME);
      try {
        await fs.access(bundled);
        return bundled;
      } catch {
        // fall through to dev path
      }
    }

    // 개발 환경: lvis-plugin-pageindex/python-requirements.lock
    const devPath = path.join(
      __dirname, "..", "..", "..", "..", "lvis-plugin-pageindex", "python-requirements.lock"
    );
    try {
      await fs.access(devPath);
      return devPath;
    } catch {
      throw new Error(
        `python-requirements.lock 파일을 찾을 수 없습니다.\n` +
        `번들 경로: ${resourcesPath ? path.join(resourcesPath, LOCK_FILE_RESOURCE_NAME) : "(없음)"}\n` +
        `개발 경로: ${devPath}`
      );
    }
  }

  // ─── private: 실행 헬퍼 ──────────────────────────

  private runUv(
    uvBin: string,
    args: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Whitelist-only env — same rationale as pageIndexPlugin.ts.
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
      ]);
      const env: NodeJS.ProcessEnv = {};
      for (const key of allowedEnvKeys) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, extraEnv);
      // uv가 interactive prompt를 띄우지 않도록
      env.UV_NO_PROGRESS = "1";

      const proc = spawn(uvBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });

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
      "import fitz, lancedb, kiwipiepy",
      "import sys",
      "print(sys.version.split()[0])",
    ].join("; ");

    const version = await this.runPython(pythonBin, ["-c", verifyScript]).catch((err: Error) => {
      throw new Error(
        `필수 라이브러리 import 검증 실패.\n` +
        `fitz (pymupdf), lancedb, kiwipiepy가 설치되어 있는지 확인하세요.\n` +
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
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.mkdir(PYTHON_INSTALL_DIR, { recursive: true });
  }

  private async log(msg: string): Promise<void> {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      await fs.mkdir(LOGS_DIR, { recursive: true });
      await fs.appendFile(SETUP_LOG, line, "utf8");
    } catch {
      // 로그 실패는 무시 (non-fatal)
    }
    console.log(msg);
  }
}
