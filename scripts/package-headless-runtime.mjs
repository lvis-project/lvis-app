#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {};
  const supported = new Set(["app", "node", "node-license", "out"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag?.slice(2);
    if (!flag?.startsWith("--") || !supported.has(key) || !value || value.startsWith("--") || key in options) {
      throw new Error("Usage: package-headless-runtime.mjs --app <linux-unpacked> --node <standalone-node> --node-license <license> --out <new-directory>");
    }
    options[key] = resolve(value);
  }
  if ([...supported].some((key) => !options[key])) throw new Error("Missing runtime packaging argument");
  return options;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function binding(path) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size === 0) throw new Error(`Runtime file missing or empty: ${path}`);
  return { sha256: sha256(path), bytes: stats.size };
}

function inventory(root, directory = root) {
  const files = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, inventory(root, path));
    else if (entry.isFile()) files[relative(root, path).split("\\").join("/")] = { sha256: sha256(path), bytes: statSync(path).size };
    else throw new Error(`Unsupported runtime payload entry: ${path}`);
  }
  return files;
}

function main() {
  if (process.platform !== "linux") throw new Error("Build the standalone Linux runtime on Linux");
  const options = parseArguments(process.argv.slice(2));
  if (existsSync(options.out)) throw new Error(`Runtime output already exists: ${options.out}`);
  const appResources = join(options.app, "resources");
  const archive = join(appResources, "app.asar");
  const archiveBinding = binding(archive);
  const nodeBinding = binding(options.node);
  const licenseBinding = binding(options["node-license"]);
  const sourceCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const runtime = JSON.parse(execFileSync(options.node, ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules,napi:process.versions.napi,electron:process.versions.electron??null})"], { encoding: "utf8" }));
  if (runtime.electron !== null || runtime.platform !== "linux" || !runtime.version.startsWith("v22.")) {
    throw new Error("The server artifact requires the standalone Linux 22.x runtime");
  }
  const sourcePackage = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const boundary = JSON.parse(asar.extractFile(archive, "dist/src/main/headless-manifest.json").toString("utf8"));
  if (boundary.entryPoint !== "src/headless.ts" || !Array.isArray(boundary.externals) || !Number.isInteger(boundary.inputCount) || boundary.inputCount < 1) {
    throw new Error("The packaged server dependency manifest is invalid");
  }
  for (const dependency of boundary.externals) {
    if (typeof dependency !== "string" || /^(?:electron(?:\/|$)|electron-updater(?:\/|$)|@sentry\/electron(?:\/|$))/.test(dependency)) {
      throw new Error("The server dependency manifest contains a desktop runtime");
    }
  }

  mkdirSync(options.out, { recursive: true });
  const app = join(options.out, "app");
  mkdirSync(app);
  asar.extractAll(archive, app);
  binding(join(app, "dist/src/main/headless.js"));
  const resources = join(options.out, "resources");
  mkdirSync(resources);
  for (const entry of readdirSync(appResources)) {
    if (entry === "app.asar" || entry === "app.asar.unpacked") continue;
    cpSync(join(appResources, entry), join(resources, entry), { recursive: true, errorOnExist: true, force: false });
  }
  mkdirSync(join(options.out, "bin"));
  cpSync(options.node, join(options.out, "bin/node"));
  chmodSync(join(options.out, "bin/node"), 0o755);
  mkdirSync(join(options.out, "licenses"));
  cpSync(options["node-license"], join(options.out, "licenses/node-LICENSE"));
  writeFileSync(join(options.out, "lvis"), '#!/bin/sh\nset -eu\nlvis_runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport NODE_ENV=production\nexport LVIS_RESOURCES_DIR="$lvis_runtime_root/resources"\nexec "$lvis_runtime_root/bin/node" "$lvis_runtime_root/app/dist/src/main/headless.js" "$@"\n', { mode: 0o755 });

  const addonProbe = execFileSync(join(options.out, "bin/node"), [join(repository, "scripts/headless-runtime-smoke.mjs"), app], { encoding: "utf8", cwd: options.out });
  const nativeRuntime = JSON.parse(addonProbe.trim());
  if (nativeRuntime.database !== "ok" || nativeRuntime.terminal !== "ok") throw new Error("Native runtime qualification did not complete");
  const manifest = {
    schema: "lvis-headless-runtime/v1",
    version: sourcePackage.version,
    source: { commit: sourceCommit, tree: sourceTree },
    desktopArchive: { name: basename(archive), ...archiveBinding },
    runtime: { ...runtime, binary: nodeBinding, license: licenseBinding },
    entry: "app/dist/src/main/headless.js",
    launcher: "lvis",
    boundary,
    nativeRuntime,
    files: inventory(options.out),
  };
  writeFileSync(join(options.out, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: options.out, manifest: binding(join(options.out, "runtime-manifest.json")), files: Object.keys(manifest.files).length })}\n`);
}

main();
