import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);
const DEFAULT_NORMALIZER_PATH = fileURLToPath(
  new URL("./normalize-electron-node-runtime.mjs", import.meta.url),
);

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function resolveElectronVitestRuntime({
  loadElectron = () => require("electron"),
  resolveVitest = () => join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
  normalizerPath = DEFAULT_NORMALIZER_PATH,
} = {}) {
  let electronPath;
  let vitestPath;
  try {
    electronPath = loadElectron();
    vitestPath = resolveVitest();
  } catch (error) {
    throw new Error(`[electron-vitest-runtime-unavailable] ${errorText(error)}`, {
      cause: error,
    });
  }
  if (typeof electronPath !== "string" || electronPath.length === 0) {
    throw new Error("[electron-vitest-runtime-invalid] electron executable was not resolved");
  }
  if (typeof vitestPath !== "string" || vitestPath.length === 0) {
    throw new Error("[electron-vitest-runtime-invalid] Vitest entry was not resolved");
  }
  return { electronPath, vitestPath, normalizerPath };
}

export function createElectronVitestInvocation(
  args,
  {
    electronPath,
    vitestPath,
    normalizerPath = DEFAULT_NORMALIZER_PATH,
    cwd = process.cwd(),
    env = process.env,
    nodeExecPath = process.execPath,
  },
) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("[electron-vitest-args-invalid] Vitest arguments must be strings");
  }
  if (
    typeof electronPath !== "string" ||
    electronPath.length === 0 ||
    typeof vitestPath !== "string" ||
    vitestPath.length === 0 ||
    typeof normalizerPath !== "string" ||
    normalizerPath.length === 0
  ) {
    throw new Error("[electron-vitest-runtime-invalid] Electron and Vitest paths are required");
  }
  const normalizerOption = `--import=${pathToFileURL(normalizerPath).href}`;
  const nodeOptions = [env.NODE_OPTIONS, normalizerOption].filter(Boolean).join(" ");
  return {
    command: electronPath,
    args: [vitestPath, ...args],
    options: {
      cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        LVIS_TEST_NODE_EXEC_PATH: nodeExecPath,
        NODE_OPTIONS: nodeOptions,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

export function runVitestUnderElectron(
  args,
  {
    spawnProcess = spawn,
    signalSource = process,
    electronPath,
    vitestPath,
    normalizerPath,
    cwd,
    env,
    nodeExecPath,
  } = {},
) {
  const hasElectronPath = electronPath !== undefined;
  const hasVitestPath = vitestPath !== undefined;
  if (hasElectronPath !== hasVitestPath) {
    return Promise.reject(
      new Error(
        "[electron-vitest-runtime-invalid] electronPath and vitestPath must be provided together",
      ),
    );
  }
  const runtime = hasElectronPath
    ? {
        electronPath,
        vitestPath,
        normalizerPath: normalizerPath ?? DEFAULT_NORMALIZER_PATH,
      }
    : resolveElectronVitestRuntime();
  const invocation = createElectronVitestInvocation(args, {
    ...runtime,
    cwd,
    env,
    nodeExecPath,
  });

  let child;
  try {
    child = spawnProcess(
      invocation.command,
      invocation.args,
      invocation.options,
    );
  } catch (error) {
    return Promise.reject(
      new Error(`[electron-vitest-launch-failed] ${errorText(error)}`, {
        cause: error,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const signalHandlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        signalSource.off(signal, handler);
      }
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill(signal);
        }
      };
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(`[electron-vitest-launch-failed] ${errorText(error)}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal });
    });
  });
}

export function applyElectronVitestResult(result, targetProcess = process) {
  if (result.signal) {
    try {
      targetProcess.kill(targetProcess.pid, result.signal);
      return;
    } catch {
      targetProcess.exitCode = 1;
      return;
    }
  }
  targetProcess.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = await runVitestUnderElectron(process.argv.slice(2));
    applyElectronVitestResult(result);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
