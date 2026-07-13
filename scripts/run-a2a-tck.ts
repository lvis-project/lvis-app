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

const PINNED_TCK_HEAD = "5996b79f9cefa6fc390980e383e358a66fb9e49e";
const DEFAULT_TCK_PATH = fileURLToPath(
  new URL("../../a2a-tck-upstream/", import.meta.url),
);
const ALLOWED_JSONRPC_SKIP_PATTERNS = [
  /^CORE-CAP-004$/,
  /^CORE-STREAM-/,
  /^STREAM-/,
  /^JSONRPC-SSE-001$/,
  /^PUSH-/,
  /^CARD-(?:EXT|SIGN)/,
];

interface CompatibilityReport {
  per_requirement?: Record<
    string,
    {
      status?: string;
      transports?: Record<string, string>;
      errors?: string[];
    }
  >;
  per_transport?: Record<
    string,
    {
      total?: number;
      passed?: number;
      failed?: number;
      skipped?: number;
    }
  >;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function authHeaders(secret: string): Record<string, string> {
  return {
    authorization: "Bearer " + secret,
    "content-type": "application/json",
    "a2a-version": "1.0",
  };
}

function jsonRpcBody(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function smokeBackend(baseUrl: string, secret: string): Promise<void> {
  const card = await fetch(baseUrl + "/.well-known/agent-card.json");
  assert(card.status === 200, "public Agent Card smoke failed");

  const missingAuth = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: jsonRpcBody(1, A2AJsonRpcMethod.LIST_TASKS, {}),
  });
  assert(missingAuth.status === 401, "missing bearer did not fail closed");

  const wrongAuth = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders("wrong-secret"),
    body: jsonRpcBody(2, A2AJsonRpcMethod.LIST_TASKS, {}),
  });
  assert(wrongAuth.status === 401, "wrong bearer did not fail closed");

  const allowed = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(secret),
    body: jsonRpcBody(3, A2AJsonRpcMethod.LIST_TASKS, {}),
  });
  const allowedBody = (await allowed.json()) as Record<string, unknown>;
  assert(allowed.status === 200 && "result" in allowedBody, "correct bearer smoke failed");
}

function runTck(tckPath: string, sutUrl: string): Promise<number> {
  const executable = process.env.A2A_TCK_RUNNER ?? "uv";
  const args = [
    "run",
    "./run_tck.py",
    "--sut-host",
    sutUrl,
    "--transport",
    "jsonrpc",
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: tckPath,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("A2A TCK terminated by signal " + signal));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function verifyReport(tckPath: string): void {
  const reportPath = resolve(tckPath, "reports", "compatibility.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CompatibilityReport;
  const jsonrpc = report.per_transport?.jsonrpc;
  assert(jsonrpc !== undefined, "A2A TCK report is missing the jsonrpc transport");
  assert((jsonrpc.failed ?? 0) === 0, "A2A TCK report contains failed jsonrpc requirements");

  const unexpectedSkips = Object.entries(report.per_requirement ?? {})
    .filter(([, requirement]) => requirement.transports?.jsonrpc === "SKIPPED")
    .map(([id]) => id)
    .filter(
      (id) =>
        !ALLOWED_JSONRPC_SKIP_PATTERNS.some((pattern) => pattern.test(id)),
    );

  assert(
    unexpectedSkips.length === 0,
    "A2A TCK produced unexpected skips: " + unexpectedSkips.join(", "),
  );
  console.log(
    "A2A TCK JSON-RPC: " +
      String(jsonrpc.passed ?? 0) +
      " passed, " +
      String(jsonrpc.skipped ?? 0) +
      " skipped",
  );
}

async function main(): Promise<void> {
  const tckPath = resolve(process.env.A2A_TCK_PATH ?? DEFAULT_TCK_PATH);
  const actualHead = execFileSync(
    "git",
    ["-C", tckPath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert(
    actualHead === PINNED_TCK_HEAD,
    "A2A TCK HEAD mismatch: expected " + PINNED_TCK_HEAD + ", got " + actualHead,
  );
  const dirtyTck = execFileSync(
    "git",
    ["-C", tckPath, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  assert(dirtyTck.length === 0, "A2A TCK checkout must be clean");

  const secret = randomBytes(32).toString("hex");
  const handler = new A2ATckFixtureHandler();
  const backend = await startLocalApiHttpServer({
    api: {
      dispatch: async () => ({ ok: false, error: "channel-not-public" }),
    } satisfies LocalApi,
    secret,
    broadcaster: createStreamBroadcaster(),
    a2aRouter: createA2AHttpRouter({ handlers: [handler] }),
    host: "127.0.0.1",
    port: 0,
  });
  const backendUrl =
    "http://127.0.0.1:" + String(backend.port) + "/a2a/" + handler.id;
  let proxy: Awaited<ReturnType<typeof startA2ATckAuthProxy>> | undefined;
  try {
    await smokeBackend(backendUrl, secret);
    proxy = await startA2ATckAuthProxy({ targetUrl: backendUrl, secret });
    const publicCard = await fetch(proxy.url + "/.well-known/agent-card.json");
    const card = (await publicCard.json()) as {
      supportedInterfaces?: Array<{ url?: string }>;
    };
    assert(
      publicCard.status === 200 &&
        card.supportedInterfaces?.[0]?.url === proxy.url,
      "A2A TCK proxy Agent Card rewrite failed",
    );

    const exitCode = await runTck(tckPath, proxy.url);
    console.log("A2A TCK process exit: " + String(exitCode));
    assert(exitCode === 0, "A2A TCK exited " + String(exitCode));
    verifyReport(tckPath);
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        console.log("Closing A2A TCK proxy");
        await proxy?.close();
      })(),
      (async () => {
        console.log("Closing A2A TCK backend");
        await backend.close();
      })(),
    ]);
    console.log("A2A TCK resources closed");
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "A2A TCK cleanup failed");
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});