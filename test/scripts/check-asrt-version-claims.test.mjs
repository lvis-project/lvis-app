import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAsrtVersionClaims, runAsrtClaimsCli } from "../../scripts/check-asrt-version-claims.mjs";

function fixtureRoot(pin, files) {
  const root = mkdtempSync(join(tmpdir(), "asrt-claims-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "@anthropic-ai/sandbox-runtime": pin } }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function cli(root) {
  const err = [];
  const out = [];
  const code = runAsrtClaimsCli({ root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("passes when a claim names the pinned version, and counts older ones as history", () => {
  const root = fixtureRoot("0.0.73", {
    "src/a.ts": "// ASRT 0.0.73 cannot apply per-exec allowRead.\n",
    "src/b.ts": "// ASRT 0.0.67 REMOVED implicit vendored-binary resolution.\n",
  });
  try {
    const result = checkAsrtVersionClaims(root);
    assert.equal(result.ok, true);
    assert.equal(result.current, 1);
    assert.equal(result.claims.length, 2);
    assert.equal(cli(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bump that leaves the claims behind fails, and the failure IS the re-read list", () => {
  const root = fixtureRoot("0.0.75", {
    "src/a.ts": "// ASRT 0.0.73 cannot apply per-exec allowRead.\n",
    "docs/d.md": "ASRT 0.0.73 has no Windows process isolation.\n",
  });
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /no claim names ASRT 0\.0\.75/);
    // Every surviving claim is printed: that list is what the bumper walks.
    assert.match(err, /src\/a\.ts:1 {2}\(ASRT 0\.0\.73\)/);
    assert.match(err, /docs\/d\.md:1 {2}\(ASRT 0\.0\.73\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim about a version newer than the pin is a claim nobody here can observe", () => {
  const root = fixtureRoot("0.0.73", {
    "src/a.ts": "// ASRT 0.0.73 is what we ship.\n// ASRT 0.0.99 fixed it.\n",
  });
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /src\/a\.ts:2 claims something about ASRT 0\.0\.99, but this tree ships 0\.0\.73/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("versions compare numerically, so 0.0.9 is older than 0.0.73 rather than newer", () => {
  const root = fixtureRoot("0.0.73", {
    "src/a.ts": "// ASRT 0.0.73 ships.\n// ASRT 0.0.9 was the first with seccomp.\n",
  });
  try {
    assert.equal(checkAsrtVersionClaims(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a range instead of an exact pin makes 'the version we ship' unanswerable", () => {
  const root = fixtureRoot("^0.0.73", { "src/a.ts": "// ASRT 0.0.73\n" });
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /pinned as "\^0\.0\.73"; this gate needs an exact version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
