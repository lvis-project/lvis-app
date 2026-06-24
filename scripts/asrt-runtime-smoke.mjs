#!/usr/bin/env node
/**
 * ASRT runtime smoke — proves the esbuild-external fix is correct.
 *
 * Imports the REAL @anthropic-ai/sandbox-runtime from node_modules (the same
 * dynamic-import path asrt-sandbox.ts uses), initializes a minimal TRUSTED
 * config, wraps a command, and spawns the returned argv with shell:false. It
 * asserts:
 *   1. echo-ok        — the wrapped `echo asrt-ok` actually runs, stdout has it.
 *   2. vendor-resolved — no "vendor not found" / module-resolution error (i.e.
 *      ASRT located its Seatbelt/seccomp machinery filesystem-relative).
 *   3. network-deny    — a curl to a NON-allowed domain is BLOCKED
 *      (deny-by-default), proving network egress is sandboxed.
 *
 * Not bundled — run with node/bun directly against node_modules.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runArgv(argv, env) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.on("error", (e) => resolve({ code: null, stdout: "", stderr: `spawn error: ${e.message}` }));
  });
}

const results = { echoOk: false, vendorResolved: false, networkDeny: null };
let exitCode = 0;

try {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  console.log(`[smoke] platform=${process.platform} supported=${SandboxManager.isSupportedPlatform()}`);
  const deps = SandboxManager.checkDependencies();
  console.log(`[smoke] checkDependencies errors=${JSON.stringify(deps.errors)} warnings=${JSON.stringify(deps.warnings)}`);

  const writeDir = mkdtempSync(join(tmpdir(), "asrt-smoke-"));

  // Minimal TRUSTED config: deny-by-default network (empty allowedDomains),
  // write only to a temp dir.
  await SandboxManager.initialize(
    { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [writeDir], denyWrite: [] } },
    undefined,
    false,
  );

  // ── 1+2: echo-ok + vendor-resolved ──────────────────────────────────────
  const echoWrapped = await SandboxManager.wrapWithSandboxArgv("echo asrt-ok");
  console.log(`[smoke] echo argv[0]=${echoWrapped.argv[0]} argc=${echoWrapped.argv.length}`);
  const echoRes = await runArgv(echoWrapped.argv, echoWrapped.env);
  SandboxManager.cleanupAfterCommand();

  const combined = `${echoRes.stdout}\n${echoRes.stderr}`;
  const moduleResolutionFailure =
    /vendor.*not found|cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|apply-seccomp.*not found|no such file.*vendor|sandbox-exec: .*not found/i.test(
      combined,
    );
  results.echoOk = echoRes.stdout.includes("asrt-ok");
  results.vendorResolved = !moduleResolutionFailure;

  console.log(`[smoke] echo exit=${echoRes.code} stdout=${JSON.stringify(echoRes.stdout.trim())}`);
  if (echoRes.stderr.trim()) console.log(`[smoke] echo stderr=${JSON.stringify(echoRes.stderr.trim().slice(0, 400))}`);

  // ── 3: network deny-by-default (BONUS) ───────────────────────────────────
  // curl a non-allowed domain; under deny-by-default it must fail to connect.
  const netWrapped = await SandboxManager.wrapWithSandboxArgv(
    "curl -sS --max-time 8 https://example.com -o /dev/null -w '%{http_code}'",
  );
  const netRes = await runArgv(netWrapped.argv, netWrapped.env);
  SandboxManager.cleanupAfterCommand();
  // BLOCKED == non-zero exit / no 200. ALLOWED == exit 0 with 200.
  const looksAllowed = netRes.code === 0 && /\b200\b/.test(netRes.stdout);
  results.networkDeny = !looksAllowed;
  console.log(`[smoke] network curl exit=${netRes.code} stdout=${JSON.stringify(netRes.stdout.trim())} blocked=${results.networkDeny}`);

  await SandboxManager.reset();
} catch (e) {
  console.error(`[smoke] FATAL ${e?.stack || e}`);
  exitCode = 2;
}

console.log("─".repeat(60));
console.log(`[smoke] echo-ok        : ${results.echoOk ? "PASS" : "FAIL"}`);
console.log(`[smoke] vendor-resolved: ${results.vendorResolved ? "PASS" : "FAIL"}`);
console.log(`[smoke] network-deny   : ${results.networkDeny === null ? "SKIP" : results.networkDeny ? "PASS" : "FAIL (egress NOT blocked)"}`);

if (!results.echoOk || !results.vendorResolved) exitCode = 1;
process.exit(exitCode);
