import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findRuntimeImportCycles } from "../../scripts/check-import-cycles.mjs";

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
