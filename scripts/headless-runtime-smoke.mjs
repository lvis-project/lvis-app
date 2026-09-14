import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isAbsolute, relative } from "node:path";
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const entries = ["better-sqlite3", "node-pty", "sharp"].map((name) => ({ name, ...ownedPath(runtimeRequire.resolve(name)) }));
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
const sharp = runtimeRequire("sharp");
const imageChild = resolve(root, "dist/src/main/image-preparation-child.js");
ownedPath(imageChild);
const imageSource = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 30, g: 90, b: 160, alpha: 0.5 } } }).png().toBuffer();
const imageDirectory = mkdtempSync(resolve(tmpdir(), "lvis-runtime-image-"));
let imageResponse;
try {
  const imagePath = resolve(imageDirectory, "source.png");
  writeFileSync(imagePath, imageSource);
  imageResponse = JSON.parse(execFileSync(process.execPath, [imageChild, JSON.stringify({
    path: imagePath, options: { maxBytes: 512, maxDimension: 2 },
    scope: { cwd: imageDirectory, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true },
  })], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 8192,
    env: { ...process.env, NODE_ENV: "production" },
  }));
  assert.deepEqual(readFileSync(imagePath), imageSource, "Decoder modified the source image");
} finally {
  rmSync(imageDirectory, { recursive: true, force: true });
}
assert.equal(imageResponse.ok, true, "Packaged decoder did not return an image");
const imageBytes = Buffer.from(imageResponse.image.data, "base64");
const imageDecoded = await sharp(imageBytes).raw().toBuffer({ resolveWithObject: true });
assert.equal(imageDecoded.info.width, 2);
assert.equal(imageDecoded.info.height, 1);
assert.equal(imageDecoded.info.channels, 4);
assert.equal(imageResponse.image.width, imageDecoded.info.width);
assert.equal(imageResponse.image.height, imageDecoded.info.height);
assert.equal(imageResponse.image.bytes, imageBytes.length);
assert.equal(imageResponse.image.inputBytes, imageSource.length);
assert.ok(imageBytes.length <= 512);
const imageLibrary = ownedPath(runtimeRequire.resolve(`@img/sharp-libvips-${process.platform}-${process.arch}/binary`));
const bindings = Object.keys(runtimeRequire.cache).filter((file) => file.endsWith(".node")).map(ownedPath);
assert.ok(bindings.length >= 3, "All artifact native bindings must be loaded");
const modules = Object.keys(runtimeRequire.cache).map(ownedPath);
const runtimeEntry = resolve(root, "dist/src/main/headless.js");
ownedPath(runtimeEntry);
const resourceProbe = JSON.parse(execFileSync(process.execPath, [runtimeEntry, "--runtime-check"], {
  encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_ENV: "production" },
}).trim());
console.log(JSON.stringify({ runtime: process.version, modules: process.versions.modules, napi: process.versions.napi, database: "ok", terminal: "ok", image: { status: "ok", width: imageDecoded.info.width, height: imageDecoded.info.height, bytes: imageBytes.length, library: imageLibrary }, entries, bindings, dependencyFiles: modules, resources: resourceProbe }));
