import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const appRoot = resolve(process.argv[2] ?? ".");
const resources = resolve(process.argv[3] ?? join(appRoot, "resources"));
assert.equal(process.versions.electron, undefined, "Use the standalone runtime");
const profile = mkdtempSync(join(tmpdir(), "lvis-node-process-"));
const home = join(profile, "home");
mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
const keyFile = join(home, "secrets", "headless-key");
writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? "production",
  LVIS_HOME: home,
  LVIS_USER_DATA_DIR: join(profile, "user-data"),
  LVIS_SECRET_KEY_FILE: keyFile,
  LVIS_RESOURCES_DIR: resources,
};
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
delete env.ELECTRON_RUN_AS_NODE;
const args = [join(appRoot, "dist/src/main/headless.js"), "--serve"];
function launch() {
  const process = spawn(globalThis.process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", (bytes) => { stdout += bytes; });
  process.stderr.on("data", (bytes) => { stderr += bytes; });
  const exited = new Promise((done, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => done({ code, signal }));
  });
  return { process, exited, stdout: () => stdout, stderr: () => stderr };
}
function deadline(promise, label, ms = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function waitReady(host) {
  let poll;
  try {
    return await deadline(Promise.race([
      new Promise((done) => {
        poll = setInterval(() => {
          const line = host.stdout().split("\n").find((line) => line.startsWith('{"type":"server-ready"'));
          if (line) done(JSON.parse(line));
        }, 25);
      }),
      host.exited.then((result) => { throw new Error(`host-exited-before-ready:${JSON.stringify(result)}`); }),
    ]), "server-ready");
  } finally { clearInterval(poll); }
}
let host = launch();
let second;
let ownershipStress;
try {
  let ready = await waitReady(host);
  const infoFile = join(home, "local-api/server.json");
  let discovery = JSON.parse(readFileSync(infoFile, "utf8"));
  assert.equal(ready.pid, host.process.pid);
  assert.equal(discovery.pid, ready.pid);
  const url = `http://127.0.0.1:${ready.port}/v1/health`;
  const unauthorized = await fetch(url);
  const authorized = await fetch(url, { headers: { Authorization: `Bearer ${discovery.secret}` } });
  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
  const stress = process.argv.includes("--ownership-stress");
  if (stress) {
    assert.notEqual(process.platform, "win32", "Suspension qualification requires POSIX signals");
    host.process.kill("SIGSTOP");
    await new Promise((done) => setTimeout(done, 12_000));
  }
  second = launch();
  const secondExit = await deadline(second.exited, "second-host");
  assert.equal(secondExit.code, 75);
  assert.deepEqual(JSON.parse(readFileSync(infoFile, "utf8")), discovery);
  if (stress) {
    host.process.kill("SIGCONT");
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${discovery.secret}` } })).status, 200);
    host.process.kill("SIGKILL");
    await deadline(host.exited, "killed-owner");
    writeFileSync(join(profile, "original-stdout.log"), host.stdout());
    writeFileSync(join(profile, "original-stderr.log"), host.stderr());
    host = launch();
    ready = await waitReady(host);
    discovery = JSON.parse(readFileSync(infoFile, "utf8"));
    assert.equal(discovery.pid, host.process.pid);
    ownershipStress = { pausedMs: 12_000, pausedContenderExit: secondExit.code, resumedOwnerHealthy: true, recoveredAfterKill: true };
  }
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), executable: match[3] } : null;
  }).filter(Boolean);
  const descendants = new Set([ready.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  const processes = rows.filter((row) => descendants.has(row.pid));
  assert.ok(processes.some((row) => row.pid === ready.pid));
  assert.ok(processes.every((row) => !/electron|chromium|chrome/i.test(basename(row.executable))), "A desktop process appeared in the server tree");
  host.process.kill("SIGTERM");
  const exit = await deadline(host.exited, "server-shutdown");
  assert.equal(exit.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(infoFile, "utf8")), { port: 0, secret: "", pid: 0 });
  console.log(JSON.stringify({ profile, runtime: process.version, authorized: authorized.status, unauthorized: unauthorized.status, secondWriterExit: secondExit.code, processes, shutdownExit: exit.code, discoveryCleared: true, ownershipStress }));
} finally {
  if (host.process.exitCode === null && host.process.signalCode === null) {
    host.process.kill("SIGTERM");
    await deadline(host.exited, "failed-probe-shutdown", 15_000).catch(() => host.process.kill("SIGKILL"));
  }
  if (second?.process.exitCode === null && second.process.signalCode === null) second.process.kill("SIGKILL");
  writeFileSync(join(profile, "stdout.log"), host.stdout());
  writeFileSync(join(profile, "stderr.log"), host.stderr());
  process.stderr.write(`Process evidence: ${profile}\n`);
}
