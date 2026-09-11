import { expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { MAIN_BUNDLE_EXTERNALS } from "../../../scripts/lib/main-bundle-externals.mjs";

it("bundles the declared archive dependency and executes binary extraction from the emitted graph", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const output = await mkdtemp(join(tmpdir(), "archive-reader-bundle-"));
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: { reader: "src/tools/archive-entry-reader.ts" },
      outdir: output,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      format: "esm",
      splitting: true,
      metafile: true,
      preserveSymlinks: true,
      platform: "node",
      target: ["node22"],
      external: [...MAIN_BUNDLE_EXTERNALS],
      minifySyntax: true,
      minifyWhitespace: true,
      legalComments: "none",
      banner: { js: 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url);' },
    });
    if (!result.metafile) throw new Error("Archive bundle did not produce its dependency graph");
    expect(Object.keys(result.metafile.inputs).some((path) => path.startsWith("node_modules/tar/"))).toBe(true);
    const imports = Object.values(result.metafile.outputs).flatMap((entry) => entry.imports);
    expect(imports.filter((entry) => entry.external && (entry.path === "tar" || entry.path.startsWith("tar/")))).toEqual([]);
    expect(imports.filter((entry) => entry.external && !entry.path.startsWith("node:") && !builtinModules.includes(entry.path))).toEqual([]);
    const binary = Buffer.from([0, 255, 128, 13, 10, 17]);
    const header = new Header({ path: "binary", type: "File", size: binary.length, mode: 0o700 });
    header.encode();
    const archive = Buffer.concat([header.block!, binary, Buffer.alloc(512 - binary.length), Buffer.alloc(1024)]);
    await writeFile(join(output, "plain.data"), archive);
    await writeFile(join(output, "compressed.data"), gzipSync(archive));
    const expectedHash = createHash("sha256").update(binary).digest("hex");
    const smoke = `
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { consumeTarArchive } from "./reader.mjs";
const limits = { bufferBytes: 1024, maxPayloadBytes: 1024, maxArchiveInputBytes: 4096, maxDecodedArchiveBytes: 4096, maxEntries: 10, maxDepth: 10, maxRelativePathBytes: 1024, maxArchiveMetaEntryBytes: 1024 };
const results = [];
for (const [file, format] of [["plain.data", "tar"], ["compressed.data", "tar.gz"]]) {
  let files = 0;
  const sink = {
    async directory() { throw Error("unexpected directory"); },
    async file(path, body, attributes) {
      assert.equal(path, "binary"); assert.equal(attributes.ownerExecutable, true);
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of body) { hash.update(chunk); bytes += chunk.length; }
      assert.equal(bytes, attributes.expectedBytes); assert.equal(hash.digest("hex"), ${JSON.stringify(expectedHash)}); files++;
    },
  };
  assert.deepEqual(await consumeTarArchive(createReadStream(file), sink, { signal: new AbortController().signal, limits }), { format });
  assert.equal(files, 1); results.push(format);
}
console.log(JSON.stringify({ formats: results, hash: ${JSON.stringify(expectedHash)} }));
`;
    await writeFile(join(output, "smoke.mjs"), smoke);
    const processResult = spawnSync(process.execPath, [join(output, "smoke.mjs")], {
      cwd: output,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(processResult.status, processResult.stderr).toBe(0);
    expect(JSON.parse(processResult.stdout)).toEqual({ formats: ["tar", "tar.gz"], hash: expectedHash });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
