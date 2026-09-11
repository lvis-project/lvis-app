import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const output = resolve(source, "../../resources/shell-parser");
const temporary = mkdtempSync(join(tmpdir(), "lvis-shell-parser-build-"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const env = { ...process.env, GOTOOLCHAIN: "go1.26.5", GOWORK: "off" };
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, env, encoding: "utf8" }).trim();
try {
  for (const name of ["main.go", "go.mod", "go.sum"]) cpSync(join(source, name), join(temporary, name));
  const compiler = run("go", ["version"]);
  if (!compiler.startsWith("go version go1.26.5 ")) throw new Error("Shell parser build needs the pinned compiler");
  const module = JSON.parse(run("go", ["mod", "download", "-json", "mvdan.cc/sh/v3@v3.14.1"]));
  if (module.Sum !== "h1:bXkhQWNHCs0KZEChF8hYS6FC+T2N9mUZLbQv9blditI="
    || module.GoModSum !== "h1:syYCoFET8w9tvevxiXUtY8/ICrU+l26jHmhJDra3Vwo=") throw new Error("Shell grammar module checksum mismatch");
  const upstream = join(temporary, "upstream");
  cpSync(module.Dir, upstream, { recursive: true });
  const lexer = join(upstream, "syntax/lexer.go");
  const patchedFiles = ["syntax/lexer.go", "syntax/parser.go", "syntax/parser_arithm.go", "syntax/braces.go", "syntax/nodes.go"];
  for (const name of patchedFiles) chmodSync(join(upstream, name), 0o644);
  for (const patch of ["exact-bash-lexing.patch", "bounded-parser-recursion.patch", "bounded-brace-work.patch", "logical-shell-input.patch"]) {
    run("git", ["apply", "--check", join(source, patch)], upstream);
    run("git", ["apply", join(source, patch)], upstream);
  }
  run("go", ["mod", "edit", "-replace", "mvdan.cc/sh/v3=./upstream"]);
  const generated = join(temporary, "parser.wasm");
  const flags = ["build", "-mod=readonly", "-trimpath", "-ldflags=-buildid=", "-o", generated, "."];
  execFileSync("go", flags, { cwd: temporary, env: { ...env, GOOS: "js", GOARCH: "wasm" }, stdio: "inherit" });
  const goroot = run("go", ["env", "GOROOT"]);
  cpSync(generated, join(output, "parser.wasm"));
  cpSync(join(goroot, "lib/wasm/wasm_exec.js"), join(output, "wasm_exec.cjs"));
  cpSync(join(module.Dir, "LICENSE"), join(output, "LICENSE.parser"));
  cpSync(join(source, "LICENSE.runtime"), join(output, "LICENSE.runtime"));
  const inputs = Object.fromEntries(["build.mjs", "main.go", "go.mod", "go.sum", "exact-bash-lexing.patch", "bounded-parser-recursion.patch", "bounded-brace-work.patch", "logical-shell-input.patch", "LICENSE.runtime", "README.md"].map((name) => [name, hash(join(source, name))]));
  writeFileSync(join(output, "manifest.json"), JSON.stringify({
    compiler: "go1.26.5", module: "mvdan.cc/sh/v3", version: module.Version,
    moduleSum: module.Sum, moduleGoModSum: module.GoModSum,
    sourceInputs: inputs, upstreamLexerSha256: hash(join(module.Dir, "syntax/lexer.go")),
    patchedLexerSha256: hash(lexer), buildFlags: ["GOOS=js", "GOARCH=wasm", "-trimpath", "-ldflags=-buildid="],
    grammarFiles: { ...Object.fromEntries(patchedFiles.map((name) => [name, { original: hash(join(module.Dir, name)), patched: hash(join(upstream, name)) }])), "syntax/continuations.go": { original: null, patched: hash(join(upstream, "syntax/continuations.go")) } },
    wasmSha256: hash(join(output, "parser.wasm")), runtimeSha256: hash(join(output, "wasm_exec.cjs")),
  }, null, 2) + "\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
