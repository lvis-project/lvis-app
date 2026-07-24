import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("retired plugin contract documentation guard rejects active parallel-shape fixtures", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/check-retired-plugin-contract-docs.mjs", "--self-test"],
    { encoding: "utf8" },
  );

  assert.match(output, /self-test OK/);
});
