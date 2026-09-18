import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEADLESS_PACKAGED_MARKER_NAME,
  headlessPackagedMarkerPath,
} from "../../scripts/lib/headless-packaged-marker.mjs";
import { writeFixtureFile } from "./gate-script-runner.js";

const require = createRequire(import.meta.url);
const node = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];
const packager = pathToFileURL(resolve("scripts/package-headless-runtime.mjs")).href;
const selectedBinding = "node_modules/better-sqlite3/prebuilds/linux-x64.node";
const foreignBinding = "node_modules/better-sqlite3/prebuilds/win32-x64.node";

it("advertises the packaged permission-audit contracts", async () => {
  const module = await import(packager) as {
    HEADLESS_RUNTIME_CONTRACTS: Record<string, string>;
    HEADLESS_FORBIDDEN_INHERITED_ENV: readonly string[];
    HEADLESS_LAUNCHER: string;
  };
  expect(module.HEADLESS_RUNTIME_CONTRACTS).toEqual({
    workloadBrokerCorrelation: "lvis-workload-correlation/v1",
    permissionAuditProof: "lvis-permission-audit-proof/v1",
    permissionAuditSelfTest: "lvis-permission-audit-self-test/v1",
    launcherEnvironment: "lvis-headless-launch-environment/v1",
  });
  expect(module.HEADLESS_FORBIDDEN_INHERITED_ENV).toEqual([
    "ELECTRON_NO_ASAR",
    "ELECTRON_RUN_AS_NODE",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_UNIQUE_ID",
  ]);
  expect(module.HEADLESS_LAUNCHER).toContain("--disable-warning=UNDICI-EHPA");
  expect(module.HEADLESS_LAUNCHER).toContain('"$@"');
});

it.skipIf(process.platform === "win32")("blocks an inherited preload before every native command", async () => {
  const module = await import(packager) as { HEADLESS_LAUNCHER: string };
  const root = mkdtempSync(join(tmpdir(), "native-launch-environment-"));
  roots.push(root);
  writeFixtureFile(root, "lvis", module.HEADLESS_LAUNCHER);
  chmodSync(join(root, "lvis"), 0o755);
  const preloadMarker = join(root, "preload-executed");
  writeFixtureFile(root, "malicious-preload.cjs", `
require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "executed");
process.stdout.write("forged-output\\n");
`);
  writeFixtureFile(root, "app/dist/src/main/headless.js", `
const forbidden = ${JSON.stringify([
    "ELECTRON_NO_ASAR",
    "ELECTRON_RUN_AS_NODE",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_UNIQUE_ID",
  ])};
for (const name of forbidden) {
  if (Object.hasOwn(process.env, name)) throw new Error("inherited:" + name);
}
if (process.env.LVIS_HOME !== "/preserved/lvis-home") throw new Error("missing preserved env");
process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
`);
  mkdirSync(join(root, "bin"));
  symlinkSync(node, join(root, "bin/node"));
  for (const command of [
    `--verify-permission-audit=${"a".repeat(64)}`,
    `--create-permission-audit-self-test=${"b".repeat(64)}`,
    "--runtime-check",
  ]) {
    const result = spawnSync(join(root, "lvis"), [command], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELECTRON_NO_ASAR: "1",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_CHANNEL_FD: "9",
        NODE_CHANNEL_SERIALIZATION_MODE: "advanced",
        NODE_OPTIONS: `--require=${join(root, "malicious-preload.cjs")}`,
        NODE_PATH: "/untrusted/modules",
        NODE_UNIQUE_ID: "worker-role",
        LVIS_HOME: "/preserved/lvis-home",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("forged-output");
    expect(JSON.parse(result.stdout)).toEqual({ args: [command] });
    expect(existsSync(preloadMarker)).toBe(false);
  }
});

function runNode(args: string[]) {
  return spawnSync(node, args, {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

function fixture({ headless = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "native-package-extraction-"));
  roots.push(root);
  const input = join(root, "input");
  const archive = join(root, "app.asar");
  const unpacked = `${archive}.unpacked`;
  const app = join(root, "app");
  writeFixtureFile(input, "package.json", JSON.stringify({ name: "lvis-app" }));
  writeFixtureFile(input, "node_modules/better-sqlite3/package.json", JSON.stringify({ main: "prebuilds/linux-x64.node" }));
  writeFixtureFile(input, selectedBinding, "selected before post-pack replacement");
  writeFixtureFile(input, foreignBinding, "foreign native binding");
  if (headless) {
    writeFixtureFile(input, "dist/src/main/headless.js", "process.stdout.write('headless entry');\n");
    writeFixtureFile(input, "dist/src/main/image-preparation-child.js", "process.stdout.write('decoder entry');\n");
    writeFixtureFile(input, "node_modules/@img/sharp-linux-x64/lib/runtime.node", "decoder binding");
    chmodSync(join(input, "dist/src/main/headless.js"), 0o755);
  }
  const packed = runNode([require.resolve("@electron/asar/bin/asar.js"), "pack", input, archive, "--unpack", "*.node"]);
  expect(packed.error).toBeUndefined();
  expect(packed.status, packed.stderr).toBe(0);
  return { archive, unpacked, app };
}

function extract(archive: string, app: string) {
  return runNode(["--input-type=module", "-e",
    "const { extractPackagedRuntime } = await import(process.argv[1]); extractPackagedRuntime(process.argv[2], process.argv[3]);",
    packager, archive, app]);
}

function writeMarker(app: string) {
  return runNode(["--input-type=module", "-e",
    "const { writePackagedRuntimeMarker } = await import(process.argv[1]); writePackagedRuntimeMarker(process.argv[2]);",
    packager, app]);
}

function writeLauncherAndMarkerWithUmask(root: string) {
  return runNode(["--input-type=module", "-e", `
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { writeHeadlessLauncher, writePackagedRuntimeMarker } = await import(process.argv[1]);
    process.umask(0o077);
    const root = process.argv[2];
    const app = join(root, "app");
    mkdirSync(app, { recursive: true });
    writeHeadlessLauncher(root);
    writePackagedRuntimeMarker(app);
  `, packager, root]);
}

function readInventory(root: string) {
  return runNode(["--input-type=module", "-e",
    "const { inventory } = await import(process.argv[1]); process.stdout.write(JSON.stringify(inventory(process.argv[2])));",
    packager, root]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native packaged payload extraction", () => {
  it("retains packed files and the physical sidecar after pruning and replacement", () => {
    const { archive, unpacked, app } = fixture();
    rmSync(join(unpacked, foreignBinding));
    writeFixtureFile(unpacked, selectedBinding, "replacement native binding with different bytes");
    chmodSync(join(unpacked, selectedBinding), 0o750);
    writeFixtureFile(unpacked, "runtime-assets/added.txt", "post-pack asset");

    const headerExtraction = runNode([require.resolve("@electron/asar/bin/asar.js"), "extract", archive, `${app}-header`]);
    expect(headerExtraction.status).toBe(1);
    expect(headerExtraction.stderr).toContain("win32-x64.node");

    const result = extract(archive, app);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(app, "dist/src/main/headless.js"), "utf8")).toContain("headless entry");
    expect(readFileSync(join(app, "dist/src/main/image-preparation-child.js"), "utf8")).toContain("decoder entry");
    expect(readFileSync(join(app, "node_modules/@img/sharp-linux-x64/lib/runtime.node"), "utf8")).toBe("decoder binding");
    expect(readFileSync(join(app, selectedBinding), "utf8")).toBe("replacement native binding with different bytes");
    expect(readFileSync(join(app, "runtime-assets/added.txt"), "utf8")).toBe("post-pack asset");
    expect(existsSync(join(app, foreignBinding))).toBe(false);
    expect(existsSync(headlessPackagedMarkerPath(app))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(join(app, "dist/src/main/headless.js")).mode & 0o777).toBe(0o755);
      expect(statSync(join(app, selectedBinding)).mode & 0o777).toBe(0o750);
    }
  });

  it("creates the zero-byte marker once for the qualification phase", () => {
    const root = mkdtempSync(join(tmpdir(), "native-package-marker-"));
    roots.push(root);
    const app = join(root, "app");
    mkdirSync(app);

    const first = writeMarker(app);
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const marker = statSync(headlessPackagedMarkerPath(app));
    expect(marker.isFile()).toBe(true);
    expect(marker.size).toBe(0);
    if (process.platform !== "win32") expect(marker.mode & 0o777).toBe(0o444);
    const inventory = readInventory(root);
    expect(inventory.status, inventory.stderr).toBe(0);
    expect(JSON.parse(inventory.stdout)[`app/${HEADLESS_PACKAGED_MARKER_NAME}`]).toEqual({
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    });

    const second = writeMarker(app);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/EEXIST|already exists/);
  });

  it.skipIf(process.platform === "win32")("sets deterministic launcher and marker modes under a restrictive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "native-package-modes-"));
    roots.push(root);

    const result = writeLauncherAndMarkerWithUmask(root);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(root, "lvis")).mode & 0o777).toBe(0o755);
    expect(statSync(headlessPackagedMarkerPath(join(root, "app"))).mode & 0o777).toBe(0o444);

    const second = writeLauncherAndMarkerWithUmask(root);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/EEXIST|already exists/);
  });

  it("rejects a sidecar file that would overwrite packed content", () => {
    const { archive, unpacked, app } = fixture();
    writeFixtureFile(unpacked, "package.json", "replacement package");
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|EEXIST|ERR_FS_CP_EEXIST/);
    expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).name).toBe("lvis-app");
  });

  it("rejects an absent required server entry", () => {
    const { archive, app } = fixture({ headless: false });
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("headless.js");
  });

  it("leaves missing required native bindings fatal to the existing runtime probe", () => {
    const { archive, unpacked, app } = fixture();
    rmSync(join(unpacked, selectedBinding));
    const extracted = extract(archive, app);
    expect(extracted.status, extracted.stderr).toBe(0);
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(node, [resolve("scripts/headless-runtime-smoke.mjs"), app], {
      encoding: "utf8", timeout: 15_000, env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("linux-x64.node");
  });

  it.skipIf(process.platform === "win32")("rejects sidecar links outside the regular-file inventory", () => {
    const { archive, unpacked, app } = fixture();
    mkdirSync(join(unpacked, "runtime-assets"));
    symlinkSync("../package.json", join(unpacked, "runtime-assets/link"));
    const result = extract(archive, app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported runtime payload entry");
  });
});
