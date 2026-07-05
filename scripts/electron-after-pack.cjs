const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, rmSync, statSync } = require("node:fs");
const { constants: fsConstants, accessSync } = require("node:fs");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const LINUX_GPU_RUNTIME_FILES = [
  "libEGL.so",
  "libGLESv2.so",
  "libvk_swiftshader.so",
  "libvulkan.so.1",
  "vk_swiftshader_icd.json",
];

const MAC_WEBGL_FALLBACK_FILES = [
  "libvk_swiftshader.dylib",
  "libGLESv2.dylib",
  "libEGL.dylib",
  "vk_swiftshader_icd.json",
];

const WIN_WEBGL_FALLBACK_FILES = [
  "vk_swiftshader.dll",
  "libGLESv2.dll",
  "libEGL.dll",
  "vulkan-1.dll",
  "vk_swiftshader_icd.json",
];

function electronResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    return join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return join(context.appOutDir, "resources");
}

function assertBundledUvResource(context) {
  const resourcesDir = electronResourcesDir(context);
  const uvDir = join(resourcesDir, "uv");
  if (!existsSync(uvDir)) {
    throw new Error(`packaged uv resource missing: ${uvDir}`);
  }

  const uvTargets = readdirSync(uvDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (uvTargets.length !== 1) {
    throw new Error(`packaged uv resource must contain exactly one target; found ${uvTargets.join(", ")}`);
  }

  const uvTarget = uvTargets[0];
  const expectedPrefix = context.electronPlatformName === "win32" ? "win32-" : `${context.electronPlatformName}-`;
  if (!uvTarget.startsWith(expectedPrefix)) {
    throw new Error(`packaged uv target ${uvTarget} does not match ${context.electronPlatformName}`);
  }

  const uvTargetDir = join(uvDir, uvTarget);
  const uvBin = uvTarget.startsWith("win32-") ? "uv.exe" : "uv";
  const uvFiles = new Set(readdirSync(uvTargetDir));
  if (uvFiles.has(uvBin)) {
    throw new Error(`raw uv binary leaked into package: ${join(uvTargetDir, uvBin)}`);
  }
  if (!uvFiles.has(`${uvBin}.gz`)) {
    throw new Error(`compressed uv archive missing: ${join(uvTargetDir, `${uvBin}.gz`)}`);
  }
  if (!uvFiles.has("uv.meta.json")) {
    throw new Error(`packaged uv metadata missing: ${join(uvTargetDir, "uv.meta.json")}`);
  }
  const metaPath = join(uvTargetDir, "uv.meta.json");
  const compressedBin = join(uvTargetDir, `${uvBin}.gz`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (typeof meta.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.binarySha256)) {
    throw new Error(`packaged uv metadata has invalid binarySha256: ${metaPath}`);
  }
  const actualBinarySha256 = sha256Hex(gunzipSync(readFileSync(compressedBin)));
  if (actualBinarySha256 !== meta.binarySha256) {
    throw new Error(
      `packaged uv binary SHA mismatch: expected ${meta.binarySha256}, got ${actualBinarySha256}: ${compressedBin}`,
    );
  }

  const uvLicense = join(resourcesDir, "licenses", "uv", "LICENSE-MIT");
  if (!existsSync(uvLicense)) {
    throw new Error(`uv license notice missing: ${uvLicense}`);
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Per-platform sandbox-runtime (ASRT) vendor binary prune + assertion.
 *
 * The top-level `asarUnpack: vendor/**` glob unpacks the whole vendor dir, then
 * this afterPack prunes the binaries the platform never executes (mac → no
 * srt-win + no seccomp; linux → no srt-win; win → no seccomp).
 *
 * Why the prune lives here and NOT in per-target `build.{mac,win,linux}.files`:
 * electron-builder REPLACES (not merges) the top-level `build.files` allow-list
 * with a platform `files` array when one is present. A negation-only platform
 * `files` array therefore drops the entire positive allow-list AND every base
 * negation, so electron-builder falls back to its default glob and the whole
 * repo root + raw node_modules leak into app.asar. We delete the wrong-platform
 * vendor dirs from the already-unpacked output here instead, sidestepping that
 * replace-not-merge footgun while keeping the top-level allow-list intact.
 *
 * After pruning we assert the result is a HARD invariant of the packed artifact
 * rather than an electron-builder config detail nobody re-checks:
 *   - the KEPT binary (the one this platform's backend spawns) must be present
 *     and executable;
 *   - the PRUNED binary must be absent (no dead weight shipped per platform).
 *
 * Resolution mirrors ASRT's getSrtWinPath()/seccomp resolver: the unpacked
 * vendor dir under `app.asar.unpacked`. We do NOT call the resolvers here (they
 * run in the app process at runtime, not in the packer), so this assertion is
 * independent + fails the build loudly if the prune drifts.
 */
function assertSandboxVendorBinaries(context) {
  const platform = context.electronPlatformName;
  const resourcesDir = electronResourcesDir(context);
  const vendorDir = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    "sandbox-runtime",
    "vendor",
  );

  // Per-platform: [keptSubdir, keptBinaryBasename] + [prunedSubdir...].
  // srt-win.exe (Windows) and apply-seccomp (Linux) are vendored per-arch under
  // {x64,arm64}; the binary the host actually runs depends on the packed arch,
  // so we assert the binary exists under AT LEAST the packed arch dir.
  //
  // electron-builder's `context.arch` is the numeric Arch enum (1=x64, 3=arm64,
  // …). Map only the two arch dirs ASRT vendors; any other/unknown value falls
  // back to scanning all vendored arch dirs (null), which still asserts the
  // binary is present + executable without a brittle dependency on builder-util.
  const ARCH_DIR_BY_ENUM = { 1: "x64", 3: "arm64" };
  const arch = ARCH_DIR_BY_ENUM[context.arch] ?? null;
  const matrix = {
    win32: { keep: { dir: "srt-win", binary: "srt-win.exe" }, prune: ["seccomp"] },
    linux: { keep: { dir: "seccomp", binary: "apply-seccomp" }, prune: ["srt-win"] },
    darwin: { keep: null, prune: ["srt-win", "seccomp"] },
  };
  const spec = matrix[platform];
  if (!spec) return;

  // Prune the wrong-platform vendor dirs. The top-level allow-list packs all
  // vendored binaries; we delete the ones this platform never executes here
  // (rather than via per-target `files`, which would replace the allow-list).
  for (const pruned of spec.prune) {
    const prunedDir = join(vendorDir, pruned);
    rmSync(prunedDir, { recursive: true, force: true });
    if (existsSync(prunedDir)) {
      throw new Error(
        `packaged sandbox-runtime vendor binary not pruned for ${platform}: ${prunedDir} should be absent`,
      );
    }
  }

  if (!spec.keep) return;

  // KEPT binary must be present + executable under the packed arch (and, when
  // arch is unknown, under any vendored arch dir).
  const keepRoot = join(vendorDir, spec.keep.dir);
  if (!existsSync(keepRoot)) {
    throw new Error(
      `packaged sandbox-runtime vendor binary missing for ${platform}: ${keepRoot} (kept binary directory absent)`,
    );
  }
  const archDirs = arch ? [arch] : readdirSync(keepRoot);
  let found = false;
  for (const archDir of archDirs) {
    const binPath = join(keepRoot, archDir, spec.keep.binary);
    if (!existsSync(binPath)) continue;
    found = true;
    const mode = statSync(binPath).mode;
    // On Windows execute permission is implicit (no POSIX x-bit); assert the
    // file is a regular non-empty file. On POSIX assert the owner-execute bit.
    if (platform === "win32") {
      if (statSync(binPath).size === 0) {
        throw new Error(`packaged srt-win binary is empty: ${binPath}`);
      }
    } else {
      try {
        accessSync(binPath, fsConstants.X_OK);
      } catch {
        throw new Error(
          `packaged sandbox-runtime vendor binary not executable for ${platform}: ${binPath} (mode ${(mode & 0o777).toString(8)})`,
        );
      }
    }
  }
  if (!found) {
    throw new Error(
      `packaged sandbox-runtime vendor binary missing for ${platform}: ${spec.keep.binary} under ${keepRoot} (arch dirs: ${archDirs.join(", ")})`,
    );
  }
}

/**
 * node-pty ships a native `.node` addon (+ a `spawn-helper` exec on POSIX) that
 * the main process resolves unbundled from `app.asar.unpacked/node_modules/
 * node-pty` (the package.json `asarUnpack` glob). Assert both are present and
 * (POSIX) executable so a prune regression fails the BUILD loudly instead of
 * bricking the terminal at runtime with an `ERR_DLOPEN_FAILED` / missing
 * spawn-helper. node-pty is N-API (ABI-stable), so no per-Electron-ABI matrix
 * is needed here — presence + exec bit is the correct packaged invariant.
 */
function assertNodePtyBinary(context) {
  const platform = context.electronPlatformName;
  const resourcesDir = electronResourcesDir(context);
  const ptyRoot = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  const requiredNativeFiles = platform === "win32"
    ? [
        "pty.node",
        "conpty.node",
        "conpty_console_list.node",
        "winpty.dll",
        "winpty-agent.exe",
      ]
    : ["pty.node"];
  for (const file of requiredNativeFiles) {
    const nodeAddon = join(ptyRoot, file);
    if (!existsSync(nodeAddon)) {
      throw new Error(
        `packaged node-pty native addon missing: ${nodeAddon} (asarUnpack of node_modules/node-pty/** drifted?)`,
      );
    }
    if (statSync(nodeAddon).size === 0) {
      throw new Error(`packaged node-pty native addon is empty: ${nodeAddon}`);
    }
  }
  // POSIX: node-pty forks its `spawn-helper` to set the controlling TTY; it MUST
  // be present + executable. Windows is covered above by the conpty.node and
  // conpty_console_list.node addon checks — no separate helper is expected.
  if (platform !== "win32") {
    const helper = join(ptyRoot, "spawn-helper");
    if (!existsSync(helper)) {
      throw new Error(
        `packaged node-pty spawn-helper missing for ${platform}: ${helper}`,
      );
    }
    try {
      accessSync(helper, fsConstants.X_OK);
    } catch {
      throw new Error(
        `packaged node-pty spawn-helper not executable for ${platform}: ${helper} (mode ${(statSync(helper).mode & 0o777).toString(8)})`,
      );
    }
  }
}

/**
 * better-sqlite3 (#1500 / E3) ships a native `better_sqlite3.node` addon that
 * the main process resolves unbundled from
 * `app.asar.unpacked/node_modules/better-sqlite3` (the package.json `asarUnpack`
 * glob). E3's cross-session FTS5 search index is its first runtime consumer, so
 * a prune/asarUnpack regression would brick search at runtime with an
 * `ERR_DLOPEN_FAILED` (or `bindings` failing to locate the addon inside the
 * asar). Assert presence + non-empty so the BUILD fails loudly instead. The
 * `require('bindings')(...)` resolver needs `bindings` + `file-uri-to-path`
 * unpacked alongside the addon (also in the asarUnpack list); it walks the
 * filesystem and cannot see paths inside `app.asar`. better-sqlite3 is compiled
 * per-Electron-ABI by the postinstall `electron-rebuild`, so presence — not an
 * ABI matrix — is the correct packaged invariant here.
 */
function assertBetterSqlite3Binary(context) {
  const resourcesDir = electronResourcesDir(context);
  const addon = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(addon)) {
    throw new Error(
      `packaged better-sqlite3 native addon missing: ${addon} (asarUnpack of node_modules/better-sqlite3/** drifted?)`,
    );
  }
  if (statSync(addon).size === 0) {
    throw new Error(`packaged better-sqlite3 native addon is empty: ${addon}`);
  }
  // `bindings` (+ its `file-uri-to-path` dep) must be unpacked too — the
  // resolver at better-sqlite3/lib/database.js walks the FS to find the addon.
  for (const pkg of ["bindings", "file-uri-to-path"]) {
    const pkgJson = join(resourcesDir, "app.asar.unpacked", "node_modules", pkg, "package.json");
    if (!existsSync(pkgJson)) {
      throw new Error(
        `packaged better-sqlite3 resolver dep missing: ${pkgJson} (asarUnpack of node_modules/${pkg}/** drifted?)`,
      );
    }
  }
}

module.exports = async function afterPack(context) {
  const keepWebgl = process.env.LVIS_KEEP_WEBGL === "1";
  assertBundledUvResource(context);
  assertSandboxVendorBinaries(context);
  assertNodePtyBinary(context);
  assertBetterSqlite3Binary(context);

  if (context.electronPlatformName === "linux") {
    for (const file of LINUX_GPU_RUNTIME_FILES) {
      rmSync(join(context.appOutDir, file), { force: true });
    }
    return;
  }

  if (keepWebgl) return;

  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    const frameworkLibs = join(
      context.appOutDir,
      `${productFilename}.app`,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Libraries",
    );
    for (const file of MAC_WEBGL_FALLBACK_FILES) {
      rmSync(join(frameworkLibs, file), { force: true });
    }
    return;
  }

  if (context.electronPlatformName === "win32") {
    for (const file of WIN_WEBGL_FALLBACK_FILES) {
      rmSync(join(context.appOutDir, file), { force: true });
    }
  }
};
