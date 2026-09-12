import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isAbsolute, relative } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = realpathSync(resolve(process.argv[2] ?? "."));
assert.ok(!process.env.NODE_PATH && !process.env.NODE_OPTIONS, "Runtime qualification must not inherit module search paths or preloads");
assert.ok(!process.execArgv.some((arg) => /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=|$)/.test(arg)), "Runtime qualification must not preload code");
function ownedPath(path) {
  const canonical = realpathSync(path);
  const name = relative(root, canonical);
  assert.ok(name !== ".." && !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(name), `Runtime dependency escaped artifact: ${path}`);
  return { path: name.replaceAll("\\", "/"), sha256: createHash("sha256").update(readFileSync(canonical)).digest("hex") };
}
const packagePath = resolve(root, "package.json");
ownedPath(packagePath);
assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).name, "lvis-app", "Runtime artifact package identity is missing");
const runtimeRequire = createRequire(pathToFileURL(packagePath));
assert.equal(process.versions.electron, undefined, "Run the server runtime probe with the standalone runtime");
const entries = ["better-sqlite3", "node-pty"].map((name) => ({ name, ...ownedPath(runtimeRequire.resolve(name)) }));
const Database = runtimeRequire("better-sqlite3");
const database = new Database(":memory:");
assert.deepEqual(database.prepare("SELECT 42 AS value").get(), { value: 42 });
database.close();
const pty = runtimeRequire("node-pty");
const terminal = pty.spawn(process.execPath, ["-e", "process.stdout.write('runtime-ok')"], { name: "xterm", cols: 80, rows: 24, cwd: root, env: process.env });
let output = "";
terminal.onData((data) => { output += data; });
await new Promise((done, reject) => {
  const timer = setTimeout(() => { terminal.kill(); reject(new Error("runtime-terminal-timeout")); }, 10_000);
  terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? done() : reject(new Error(`runtime-terminal-exit:${exitCode}`)); });
});
assert.match(output, /runtime-ok/);
const bindings = Object.keys(runtimeRequire.cache).filter((file) => file.endsWith(".node")).map(ownedPath);
assert.ok(bindings.length >= 2, "Both artifact native bindings must be loaded");
const modules = Object.keys(runtimeRequire.cache).map(ownedPath);
const runtimeEntry = resolve(root, "dist/src/main/headless.js");
ownedPath(runtimeEntry);
const resourceProbe = JSON.parse(execFileSync(process.execPath, [runtimeEntry, "--runtime-check"], {
  encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_ENV: "production" },
}).trim());
console.log(JSON.stringify({ runtime: process.version, modules: process.versions.modules, napi: process.versions.napi, database: "ok", terminal: "ok", entries, bindings, dependencyFiles: modules, resources: resourceProbe }));
