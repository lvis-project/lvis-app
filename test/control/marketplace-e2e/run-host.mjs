import { spawn } from "node:child_process";
import { access, constants, mkdir, open, readFile } from "node:fs/promises";
import process from "node:process";

const candidateRoot = process.env.CANDIDATE_APP_ROOT;
const evidencePath = process.env.BUNDLE_E2E_EVIDENCE_PATH;
if (candidateRoot !== "/candidate/app") {
  throw new Error("CANDIDATE_APP_ROOT must be exactly /candidate/app");
}
if (evidencePath !== "/evidence/host-lifecycle.json") {
  throw new Error("evidence must use the isolated evidence volume");
}
if (process.getuid?.() === 0) {
  throw new Error("trusted Host control must run as a non-root user");
}
await access(`${candidateRoot}/dist/src/main/main.js`, constants.R_OK);
await access("/artifacts/lvis-plugin-ep.zip", constants.R_OK);
await access("/artifacts/sdk-evidence.json", constants.R_OK);
await mkdir("/tmp/test-results", { recursive: true });
await mkdir("/tmp/private-logs", { recursive: true });
await mkdir("/tmp/home", { recursive: true });
await mkdir("/tmp/xdg", { recursive: true });

const refs = ["HOST_SHA", "MARKETPLACE_SHA", "SDK_SHA", "EP_API_SHA", "CONTROL_SHA"];
for (const name of refs) {
  if (!/^[0-9a-f]{40}$/.test(process.env[name] ?? "")) {
    throw new Error(`${name} must be an exact lowercase commit SHA`);
  }
}

async function run(label, command, args, extraEnv = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) {
    throw new Error("trusted phase label is invalid");
  }
  const log = await open(`/tmp/private-logs/${label}.log`, "wx", 0o600);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = async (error) => {
      if (settled) return;
      settled = true;
      await log.close();
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(command, args, {
      cwd: candidateRoot,
      env: { ...process.env, ...extraEnv },
      shell: false,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.once("error", async () => {
      await settle(new Error(`trusted phase ${label} failed to launch`));
    });
    child.once("exit", async (code, signal) => {
      if (code === 0 && signal == null) {
        process.stdout.write(`trusted phase ${label}: ok\n`);
        await settle();
      } else {
        await settle(
          new Error(`trusted phase ${label} failed with code=${code} signal=${signal}`),
        );
      }
    });
  });
}

await run("harness-integrity", "node", [
  "/trusted/control/verify-harness.mjs",
  "/trusted/control/harness-manifest.json",
  process.env.CONTROL_SHA,
]);

const proxyLog = await open("/tmp/private-logs/loopback-proxy.log", "wx", 0o600);
const proxy = spawn("node", ["/trusted/control/loopback-proxy.mjs"], {
  env: process.env,
  stdio: ["ignore", proxyLog.fd, proxyLog.fd],
});
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8765/api/v1/health");
      if (response.ok) break;
    } catch {
      // The internal Marketplace container may still be starting.
    }
    if (attempt === 39) throw new Error("Marketplace did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const vitestRunner = "/trusted/runner/scripts/run-vitest-under-electron.mjs";
  const vitestConfig = "/trusted/runner/vitest.control.config.ts";
  await run("marketplace-transport", "node", [
    vitestRunner,
    "run",
    "--config",
    vitestConfig,
    "--reporter=verbose",
    `${candidateRoot}/test/e2e/marketplace-e2e-fixture.test.ts`,
    `${candidateRoot}/test/e2e/marketplace-e2e.test.ts`,
  ]);
  await run("marketplace-lifecycle", "node", [
    "/trusted/runner/node_modules/@playwright/test/cli.js",
    "test",
    "--config=/trusted/runner/playwright.control.config.ts",
    `${candidateRoot}/test/e2e/ui/marketplace-live-lifecycle.spec.ts`,
  ]);
  await run("attendance-read-write-readback", "node", [
    "/trusted/runner/node_modules/@playwright/test/cli.js",
    "test",
    "--config=/trusted/runner/playwright.control.config.ts",
    `${candidateRoot}/test/e2e/ui/ep-attendance-live.spec.ts`,
  ], {
    EP_API_BUNDLE_PATH: "/artifacts/lvis-plugin-ep.zip",
  });
  await run("reverse-containment", "node", [
    vitestRunner,
    "run",
    "--config",
    vitestConfig,
    "--reporter=verbose",
    `${candidateRoot}/test/e2e/marketplace-containment-rehearsal.test.ts`,
  ], {
    SDK_EVIDENCE_PATH: "/artifacts/sdk-evidence.json",
  });

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  for (const key of ["liveLifecycle", "actualEpAttendance", "containmentRehearsal"]) {
    if (!evidence[key] || typeof evidence[key] !== "object") {
      throw new Error(`missing required evidence section ${key}`);
    }
  }
} finally {
  proxy.kill("SIGTERM");
  await proxyLog.close();
}
