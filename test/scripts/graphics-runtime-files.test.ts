import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/electron-after-pack.cjs") as (
  context: ReturnType<typeof createPackage>["context"],
) => Promise<void>;
const { assertGraphicsRuntimeFiles } = require("../../scripts/lib/graphics-runtime-files.cjs") as {
  assertGraphicsRuntimeFiles(directory: string, platform: string): void;
};

const roots: string[] = [];
const RUNTIME_FILES = {
  linux: ["libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "libvulkan.so.1", "vk_swiftshader_icd.json"],
  darwin: ["libEGL.dylib", "libGLESv2.dylib", "libvk_swiftshader.dylib", "vk_swiftshader_icd.json"],
  win32: ["libEGL.dll", "libGLESv2.dll", "vk_swiftshader.dll", "vulkan-1.dll", "vk_swiftshader_icd.json", "dxcompiler.dll", "dxil.dll"],
};

function putFile(path: string, content: string | Buffer = "runtime asset") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createPackage(platform: keyof typeof RUNTIME_FILES) {
  const root = mkdtempSync(join(tmpdir(), "graphics-package-"));
  roots.push(root);
  const contents = platform === "darwin" ? join(root, "Client.app", "Contents") : root;
  const resources = join(contents, platform === "darwin" ? "Resources" : "resources");
  const libraryDirectory = platform === "darwin"
    ? join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A", "Libraries")
    : root;
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  const uv = Buffer.from("executable");
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  putFile(join(resources, "uv", `${platform}-x64`, `${uvName}.gz`), gzipSync(uv));
  putFile(join(resources, "uv", `${platform}-x64`, "uv.meta.json"), JSON.stringify({
    binarySha256: createHash("sha256").update(uv).digest("hex"),
  }));
  putFile(join(resources, "licenses", "uv", "LICENSE-MIT"));
  if (platform !== "darwin") {
    const vendorPath = join(modules, "@anthropic-ai", "sandbox-runtime", "vendor",
      platform === "linux" ? "seccomp" : "srt-win", "x64",
      platform === "linux" ? "apply-seccomp" : "srt-win.exe");
    putFile(vendorPath);
    chmodSync(vendorPath, 0o755);
  }
  for (const file of platform === "win32"
    ? ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe"]
    : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"]) {
    putFile(join(modules, "node-pty", "prebuilds", `${platform}-x64`, file));
  }
  putFile(join(modules, "better-sqlite3", "prebuilds", `${platform}-x64.node`));
  for (const file of RUNTIME_FILES[platform]) putFile(join(libraryDirectory, file), file);
  return {
    libraryDirectory,
    context: {
      appOutDir: root,
      electronPlatformName: platform,
      arch: 1,
      packager: { appInfo: { productFilename: "Client" } },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged graphics runtime", () => {
  it.each(["linux", "darwin", "win32"] as const)("retains rendering assets through %s packaging", async (platform) => {
    const { context, libraryDirectory } = createPackage(platform);
    await afterPack(context);
    for (const file of RUNTIME_FILES[platform]) {
      expect(readFileSync(join(libraryDirectory, file), "utf8")).toBe(file);
    }
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, platform)).not.toThrow();
  });

  it.each(["linux", "darwin", "win32"] as const)("rejects a missing %s rendering library at package creation", async (platform) => {
    const { context, libraryDirectory } = createPackage(platform);
    const missing = join(libraryDirectory, RUNTIME_FILES[platform][0]);
    rmSync(missing);
    await expect(afterPack(context)).rejects.toThrow(missing);
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, platform)).toThrow(missing);
  });

  it("rejects empty files and directories in place of runtime libraries", () => {
    const { libraryDirectory } = createPackage("linux");
    const library = join(libraryDirectory, "libEGL.so");
    writeFileSync(library, "");
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, "linux")).toThrow(library);
    rmSync(library);
    mkdirSync(library);
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, "linux")).toThrow(library);
  });

  it.each(["unknown", "constructor", "__proto__"])("rejects unsupported target %s", (platform) => {
    expect(() => assertGraphicsRuntimeFiles(tmpdir(), platform)).toThrow("unsupported graphics runtime platform");
  });
});
