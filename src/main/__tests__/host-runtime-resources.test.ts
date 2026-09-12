import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { configureHostResources } from "../host-resources.js";
import { currentUvTarget, resolveBundledUvBinaryPath } from "../uv-runtime.js";
import { resolveStdioSpawnCommand } from "../../mcp/mcp-client.js";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function packagedResources() {
  const root = mkdtempSync(join(tmpdir(), "host-uv-resource-"));
  fixtures.push(root);
  const target = currentUvTarget();
  const directory = join(root, "resources/uv", target.dir);
  const bytes = Buffer.from("bundled-uv-integrity-fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${target.bin}.gz`), gzipSync(bytes));
  writeFileSync(join(directory, "uv.meta.json"), JSON.stringify({ binarySha256: createHash("sha256").update(bytes).digest("hex") }));
  configureHostResources({ resourcePath: join(root, "resources"), isPackaged: true });
  return { root, directory, target, bytes, uvRuntimeDir: join(root, "cache") };
}

describe("host-owned packaged tool resources", () => {
  it("materializes the verified archive for both direct UV and MCP uvx resolution", () => {
    const fixture = packagedResources();
    const binary = resolveBundledUvBinaryPath({ uvRuntimeDir: fixture.uvRuntimeDir });
    expect(readFileSync(binary)).toEqual(fixture.bytes);
    expect(binary.startsWith(fixture.uvRuntimeDir)).toBe(true);
    expect(resolveStdioSpawnCommand("uvx", ["--help"], { uvRuntimeDir: fixture.uvRuntimeDir })).toEqual({ command: binary, args: ["tool", "run", "--help"] });
  });

  it("refuses a missing or altered packaged archive instead of selecting a host install", () => {
    const fixture = packagedResources();
    const archive = join(fixture.directory, `${fixture.target.bin}.gz`);
    rmSync(archive);
    expect(() => resolveBundledUvBinaryPath({ uvRuntimeDir: fixture.uvRuntimeDir })).toThrow("packaged uv archive not found");
    writeFileSync(archive, gzipSync("different-binary"));
    expect(() => resolveStdioSpawnCommand("uvx", [], { uvRuntimeDir: fixture.uvRuntimeDir })).toThrow("packaged uv binary SHA mismatch");
  });
});
