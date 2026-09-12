import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createNodeBootHost } from "./boot/node-host-runtime.js";
import { setIsPackaged } from "./boot/dev-flags.js";
import { projectRoot } from "./main/main-paths.js";
import { ensureWorkspaceCwd } from "./main/ensure-workspace-cwd.js";
import { scrubPackagedProcessEnv } from "./main/packaged-env-scrub.js";
import { isAuthorizedWorkspaceProjectRoot } from "./main/project-root-authorization.js";
import { acquireHostInstanceLock } from "./main/host-instance-lock.js";
import { createWindowlessHost } from "./main/windowless-host.js";
import { probeHostRuntimeResources } from "./main/host-runtime-probe.js";
import { runAppShutdownCleanup, runIncompleteBootShutdown, runShutdownHooks } from "./main/app-shutdown.js";
import { sealManagedChildProcessAdmission } from "./main/managed-child-processes.js";
import { setAppShutdownStarted } from "./main/app-state.js";
import { errorMessage } from "./shared/error-message.js";
import {
  EXEC_FAILURE_EXIT_CODE,
  EXEC_LOCKED_EXIT_CODE,
  EXEC_USAGE_EXIT_CODE,
  parseExecFlags,
  readAllStdin,
  runExecTurn,
  waitForExecRelease,
} from "./main/exec-mode.js";

function userDataPath(argv: readonly string[]): string {
  const argument = argv.find((value) => value.startsWith("--user-data-dir="));
  const explicit = argument?.slice("--user-data-dir=".length) ?? process.env.LVIS_USER_DATA_DIR;
  if (explicit !== undefined) {
    if (!explicit) throw new Error("user-data-directory-empty");
    return resolve(explicit);
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "LVIS");
  if (process.platform === "win32") {
    if (!process.env.APPDATA) throw new Error("user-data-directory-unavailable");
    return join(process.env.APPDATA, "LVIS");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "LVIS");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const packaged = process.env.NODE_ENV === "production";
  if (packaged) scrubPackagedProcessEnv(process.env);
  setIsPackaged(packaged);
  if (argv.includes("--runtime-check")) {
    if (argv.length !== 1) {
      process.stderr.write("--runtime-check must be used alone\n");
      return EXEC_USAGE_EXIT_CODE;
    }
    process.stdout.write(`${JSON.stringify(probeHostRuntimeResources({
      resourcePath: process.env.LVIS_RESOURCES_DIR ?? join(projectRoot, "resources"),
      isPackaged: packaged,
    }))}\n`);
    return 0;
  }
  const serve = argv.includes("--serve");
  const request = parseExecFlags(argv, process.cwd());
  const invalidServeArguments = serve && argv.some((arg) => arg !== "--serve" && !arg.startsWith("--user-data-dir="));
  if (invalidServeArguments || (serve && request !== null) || (!serve && request === null) || (request && "error" in request)) {
    process.stderr.write(`${request && "error" in request ? request.error : "Use --exec, --set-secret, or --serve"}\n`);
    return EXEC_USAGE_EXIT_CODE;
  }
  const profile = userDataPath(argv);
  ensureWorkspaceCwd();
  await acquireHostInstanceLock();
  let host: Awaited<ReturnType<typeof createNodeBootHost>> | undefined;
  let interrupted = false;
  let starting = true;
  let runtime: Awaited<ReturnType<typeof createWindowlessHost>> | undefined;
  let releaseServe: (() => void) | undefined;
  let interruptBootstrap: ((error: Error) => void) | undefined;
  const bootstrapInterruption = new Promise<never>((_resolve, reject) => { interruptBootstrap = reject; });
  const onSignal = () => {
    interrupted = true;
    if (starting) {
      process.exitCode = EXEC_FAILURE_EXIT_CODE;
      setAppShutdownStarted(true);
      sealManagedChildProcessAdmission("host bootstrap interrupted");
      interruptBootstrap?.(new Error("host-bootstrap-interrupted"));
    }
    runtime?.services.conversationLoop.abortCurrentTurn();
    releaseServe?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await Promise.race([(async () => {
      host = await createNodeBootHost({
        userDataPath: profile,
        resourcePath: process.env.LVIS_RESOURCES_DIR ?? join(projectRoot, "resources"),
        keyFilePath: process.env.LVIS_SECRET_KEY_FILE,
        isPackaged: packaged,
      });
      if (interrupted) throw new Error("host-bootstrap-interrupted");
      runtime = await createWindowlessHost(projectRoot, host);
    })(), bootstrapInterruption]);
    if (interrupted) return EXEC_FAILURE_EXIT_CODE;
    if (!runtime) throw new Error("host-runtime-unavailable");
    if (serve) {
      // This explicit command opts into the existing authenticated listener.
      process.env.LVIS_LOCAL_API = "1";
      const listener = await Promise.race([runtime.startLocalApi(), bootstrapInterruption]);
      if (!listener) throw new Error("local-api-server-unavailable");
      await Promise.race([runtime.startTailnetSurface(), bootstrapInterruption]);
      starting = false;
      process.stdout.write(`${JSON.stringify({ type: "server-ready", port: listener.port, pid: process.pid })}\n`);
      await new Promise<void>((done) => {
        releaseServe = done;
        if (interrupted) done();
      });
      return 0;
    }
    starting = false;
    if (!request || "error" in request) throw new Error("exec-request-unavailable");
    const { services } = runtime;
    return await runExecTurn({
      conversationLoop: services.conversationLoop,
      permissionManager: services.conversationLoop.permissionManager,
      approvalGate: services.approvalGate,
      settingsService: services.settingsService,
      stdout: process.stdout,
      stderr: process.stderr,
      readStdin: readAllStdin,
      isAuthorizedProjectRoot: isAuthorizedWorkspaceProjectRoot,
      waitForRelease: () => interrupted ? Promise.resolve() : waitForExecRelease(),
      flushTelemetry: services.flushTracing,
    }, request);
  } catch (error) {
    process.exitCode = EXEC_FAILURE_EXIT_CODE;
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    runShutdownHooks();
    const outcome = runtime
      ? await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false })
      : await runIncompleteBootShutdown(host);
    if (outcome === "failed" || outcome === "timed-out") process.exitCode = EXEC_FAILURE_EXIT_CODE;
    runtime?.conversationSurfaceRuntime.sharedProjection.stop();
  }
}

main().then((code) => {
  process.exit(typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : code);
}, (error: unknown) => {
  const message = errorMessage(error);
  process.stderr.write(`headless: ${message}\n`);
  process.exit(message === "host-already-running" ? EXEC_LOCKED_EXIT_CODE : EXEC_FAILURE_EXIT_CODE);
});
