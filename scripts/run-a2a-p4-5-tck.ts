import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createA2AHttpRouter } from "../src/api/a2a-router.js";
import { startLocalApiHttpServer } from "../src/api/http-server.js";
import type { LocalApi } from "../src/api/local-api.js";
import { createStreamBroadcaster } from "../src/api/stream-broadcaster.js";
import { A2AJsonRpcMethod } from "../src/shared/a2a-wire.js";
import { startA2ATckAuthProxy } from "./a2a-tck/auth-proxy.js";
import { A2ATckFixtureHandler } from "./a2a-tck/fixture.js";
import { resolveUvTarget } from "./uv-targets.mjs";

const PINNED_TCK_TAG = "1.0.0.alpha2";
const PINNED_TCK_HEAD = "29063fe95e903cddac5d8ff811ab94df1ad6ef86";
const ALLOWED_JSONRPC_SKIP_PATTERNS = [
  /^CORE-CAP-004$/,
  /^CORE-STREAM-/,
  /^STREAM-/,
  /^JSONRPC-SSE-001$/,
  /^PUSH-/,
  /^CARD-(?:EXT|SIGN)/,
];

interface CompatibilityReport {
  per_requirement?: Record<string, { transports?: Record<string, string> }>;
  per_transport?: Record<string, { total?: number; passed?: number; failed?: number; skipped?: number }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function authHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json", "a2a-version": "1.0" };
}

function jsonRpcBody(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function smokeBackend(baseUrl: string, secret: string): Promise<void> {
  const card = await fetch(`${baseUrl}/.well-known/agent-card.json`);
  assert(card.status === 200, "P4-5 TCK public Agent Card smoke failed");
  const denied = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: jsonRpcBody(1, A2AJsonRpcMethod.LIST_TASKS, {}),
  });
  assert(denied.status === 401, "P4-5 TCK missing bearer did not fail closed");
  const allowed = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(secret),
    body: jsonRpcBody(2, A2AJsonRpcMethod.LIST_TASKS, {}),
  });
  const allowedBody = await allowed.json() as Record<string, unknown>;
  assert(allowed.status === 200 && "result" in allowedBody, "P4-5 TCK bearer smoke failed");
}

function bundledUvPath(): string {
  const target = resolveUvTarget(process.platform, process.arch);
  return resolve(fileURLToPath(new URL("../", import.meta.url)), "resources", "uv", target.dir, target.bin);
}

function runTck(tckPath: string, sutUrl: string): Promise<number> {
  const executable = process.env.A2A_TCK_RUNNER ?? bundledUvPath();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      "run", "--frozen", "./run_tck.py", "--sut-host", sutUrl, "--transport", "jsonrpc",
    ], {
      cwd: tckPath,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`P4-5 TCK terminated by signal ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
}

function verifyReport(tckPath: string): void {
  const report = JSON.parse(readFileSync(resolve(tckPath, "reports/compatibility.json"), "utf8")) as CompatibilityReport;
  const jsonrpc = report.per_transport?.jsonrpc;
  assert(jsonrpc !== undefined, "P4-5 TCK report is missing jsonrpc");
  assert((jsonrpc.failed ?? 0) === 0, "P4-5 TCK report contains failed jsonrpc requirements");
  const unexpected = Object.entries(report.per_requirement ?? {})
    .filter(([, requirement]) => requirement.transports?.jsonrpc === "SKIPPED")
    .map(([id]) => id)
    .filter((id) => !ALLOWED_JSONRPC_SKIP_PATTERNS.some((pattern) => pattern.test(id)));
  assert(unexpected.length === 0, `P4-5 TCK produced unexpected skips: ${unexpected.join(", ")}`);
  process.stdout.write(`P4-5 TCK JSON-RPC passed=${jsonrpc.passed ?? 0} skipped=${jsonrpc.skipped ?? 0}\n`);
}

async function main(): Promise<void> {
  const suppliedPath = process.env.A2A_P4_5_TCK_PATH;
  assert(suppliedPath, "A2A_P4_5_TCK_PATH is required");
  const tckPath = resolve(suppliedPath);
  assert(git(tckPath, "rev-parse", "HEAD") === PINNED_TCK_HEAD, "P4-5 TCK HEAD mismatch");
  assert(git(tckPath, "status", "--porcelain", "--untracked-files=all") === "", "P4-5 TCK checkout must be clean");
  assert(git(tckPath, "tag", "--points-at", "HEAD") === PINNED_TCK_TAG, `P4-5 TCK must be exact tag ${PINNED_TCK_TAG}`);

  const secret = randomBytes(32).toString("hex");
  const handler = new A2ATckFixtureHandler();
  const backend = await startLocalApiHttpServer({
    api: { dispatch: async () => ({ ok: false, error: "channel-not-public" }) } satisfies LocalApi,
    secret,
    broadcaster: createStreamBroadcaster(),
    a2aRouter: createA2AHttpRouter({ handlers: [handler] }),
    host: "127.0.0.1",
    port: 0,
  });
  const backendUrl = `http://127.0.0.1:${backend.port}/a2a/${handler.id}`;
  let proxy: Awaited<ReturnType<typeof startA2ATckAuthProxy>> | undefined;
  try {
    await smokeBackend(backendUrl, secret);
    proxy = await startA2ATckAuthProxy({ targetUrl: backendUrl, secret });
    const exitCode = await runTck(tckPath, proxy.url);
    assert(exitCode === 0, `P4-5 TCK exited ${exitCode}`);
    verifyReport(tckPath);
  } finally {
    const cleanup = await Promise.allSettled([proxy?.close(), backend.close()]);
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "P4-5 TCK cleanup failed");
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
