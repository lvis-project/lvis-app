import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  findRuntimeImportCycles,
  normalizeDisplayPath,
} from "../../scripts/check-import-cycles.mjs";

const cycleChecker = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/check-import-cycles.mjs",
);

test("detects runtime cycles while ignoring type-only edges", () => {
  const root = mkdtempSync(join(tmpdir(), "lvis-import-cycles-"));
  try {
    mkdirSync(join(root, "acyclic"));
    writeFileSync(join(root, "a.ts"), 'import { b } from "./b.js"; export const a = b;\n');
    writeFileSync(join(root, "b.ts"), 'export { c as b } from "./c.js";\n');
    writeFileSync(join(root, "c.ts"), 'import { a } from "./a.js"; export const c = a;\n');
    writeFileSync(
      join(root, "types.ts"),
      'import type { value } from "./acyclic/consumer.js"; export interface Shape { value: typeof value.value }\n',
    );
    writeFileSync(
      join(root, "acyclic", "consumer.ts"),
      'import type { Shape } from "../types.js"; export const value: Shape = { value: "ok" }; export { type Shape as ReexportedShape } from "../types.js";\n',
    );
    assert.deepEqual(findRuntimeImportCycles(root), [{
      members: ["a.ts", "b.ts", "c.ts"],
      edges: ["a.ts -> b.ts", "b.ts -> c.ts", "c.ts -> a.ts"],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects cycles through package import aliases and self-imports", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "lvis-import-alias-cycles-"));
  const root = join(packageRoot, "src");
  try {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#lib/*": "./src/lib/*.ts" },
    }));
    writeFileSync(join(root, "entry.ts"), 'import { helper } from "#lib/helper"; export const entry = helper;\n');
    writeFileSync(join(root, "lib", "helper.ts"), 'import { entry } from "../entry.js"; export const helper = entry;\n');
    writeFileSync(join(root, "self.ts"), 'import { self } from "./self.js"; export { self };\n');

    assert.deepEqual(findRuntimeImportCycles(root), [
      {
        members: ["entry.ts", "lib/helper.ts"],
        edges: ["entry.ts -> lib/helper.ts", "lib/helper.ts -> entry.ts"],
      },
      {
        members: ["self.ts"],
        edges: ["self.ts -> self.ts"],
      },
    ]);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("substitutes every package-import wildcard literally", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "lvis-import-repeated-wildcard-"));
  const root = join(packageRoot, "src");
  try {
    mkdirSync(join(root, "features", "$&"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#feature/*": "./src/features/*/*.ts" },
    }));
    writeFileSync(
      join(root, "entry.ts"),
      'import { feature } from "#feature/$&"; export const entry = feature;\n',
    );
    writeFileSync(
      join(root, "features", "$&", "$&.ts"),
      'import { entry } from "../../entry.js"; export const feature = entry;\n',
    );

    assert.deepEqual(findRuntimeImportCycles(root), [{
      members: ["entry.ts", "features/$&/$&.ts"],
      edges: ["entry.ts -> features/$&/$&.ts", "features/$&/$&.ts -> entry.ts"],
    }]);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("normalizes Windows diagnostics to portable separators", () => {
  assert.equal(normalizeDisplayPath("lib\\helper.ts", "\\"), "lib/helper.ts");
});

test("CLI rejects a cyclic source tree with a stable diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "lvis-import-cycle-cli-"));
  try {
    writeFileSync(join(root, "a.ts"), 'import { b } from "./b.js"; export const a = b;\n');
    writeFileSync(join(root, "b.ts"), 'import { a } from "./a.js"; export const b = a;\n');

    const result = spawnSync(process.execPath, [cycleChecker, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[import-cycles\] FAIL cycles=1/mu);
    assert.match(result.stderr, /cycle 1: a\.ts, b\.ts/u);
    assert.match(result.stderr, /a\.ts -> b\.ts/u);
    assert.match(result.stderr, /b\.ts -> a\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
