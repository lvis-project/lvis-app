import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { isReadOnlyCommand } from "../../permissions/reviewer/host-risk-inspector.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";

describe("database CLI argument roles", () => {
  let root: string, cwd: string, outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shell-database-arguments-")));
    cwd = join(root, "allowed"); outside = join(root, "outside");
    mkdirSync(cwd); mkdirSync(outside);
  });
  afterEach(async () => { await cleanupTmpDir(root); });
  const policy = (command: string, readFence = true) => findShellPathPolicyViolation(
    command, cwd, cwd, [], readFence, { dialect: "bash", environment: { HOME: cwd, PWD: cwd } },
  );
  const call = (program: string) => `sqlite3 sample.db ${shellQuote(program)}`;

  it.each([32, 300, 4096])("keeps a %i-character SQL identifier out of path resolution", (length) => {
    const command = call(`SELECT 1 AS "${"x".repeat(length)}";`);
    for (const readFence of [false, true]) expect(policy(command, readFence)).toBeNull();
    expect(isReadOnlyCommand(command)).toBe(false);
  });

  it.each([
    "sqlite3 :memory: 'SELECT 1;'",
    "sqlite3 '' 'SELECT 1;'",
    "sqlite3 -cmd 'SELECT 1;' sample.db 'SELECT 2;' 'SELECT 3;'",
    "sqlite3 --batch --readonly --init init.sql sample.db --cmd 'SELECT 1;' 'SELECT 2;'",
    "sqlite3 -separator /etc/shadow -newline ../outside/newline -nullvalue /etc/shadow sample.db 'SELECT 1;'",
    "sqlite3 -lookaside 128 32 -pagecache 4096 2 sample.db 'SELECT 1;'",
    "sqlite3 -init -cmd sample.db 'SELECT 1;'",
    "sqlite3 -separator -init sample.db 'SELECT 1;'",
    "sqlite3 -- -database 'SELECT 1;'",
    "sqlite3 sample.db -separator '|' 'SELECT 1;'",
    'sqlite3 -nullvalue "$UNKNOWN_DATA" sample.db "SELECT 1;"',
    "sqlite3 -init > ./log init.sql sample.db 'SELECT 1;' 2>&1",
    "sqlite3 'file:sample.db?mode=rwc' 'SELECT 1;'",
    "sqlite3 sample.db '.mode box' '.headers on' 'SELECT 1;' '.print /etc/shadow'",
  ])("consumes declared options before assigning positional roles: %s", (command) => {
    expect(policy(command)).toBeNull();
  });

  it.each([
    "SELECT '/etc/shadow', 'readfile(''../outside/file'')', 'ATTACH ''../outside/db'' AS other';",
    "SELECT 1 /* readfile('/etc/shadow') */; -- ATTACH '/etc/shadow' AS other",
    ";; -- empty statements\n SELECT 1;",
    "SELECT 1 AS readfile, 2 AS csv, 3 AS fsdir;",
    'SELECT 1 AS "attach", 2 AS "vacuum", 3 AS "pragma";',
    "SELECT readfile('input.txt');",
    "SELECT writefile('output.txt', 'bytes');",
    "ATTACH DATABASE 'other.db' AS other; VACUUM main INTO 'backup.db';",
    "ATTACH 'database' AS other;",
    "PRAGMA main.temp_store_directory = 'scratch';",
    ".read input.sql",
    ".output 'report file.txt'",
    ".once report.txt",
    ".backup main backup.db",
    ".restore main saved.db",
    ".save saved.db",
    ".clone cloned.db",
    ".open --readonly other.db",
    ".open :memory:",
  ])("allows represented file effects only inside the allowed directory: %s", (program) => {
    expect(policy(call(program))).toBeNull();
  });

  it.each([
    "sqlite3 /etc/shadow 'SELECT 1;'",
    "sqlite3 -init /etc/shadow sample.db 'SELECT 1;'",
    "sqlite3 -lookaside 128 32 /etc/shadow 'SELECT 1;'",
    "sqlite3 -cmd 'SELECT 1;' /etc/shadow",
    "sqlite3 sample.db 'SELECT 1;' > /etc/shadow",
    "sqlite3 sample.db 'SELECT 1;' < /etc/shadow",
    'sqlite3 sample.db "SELECT $(cat /etc/shadow);"',
    "sqlite3 'file:/etc/%73hadow?mode=ro' 'SELECT 1;'",
    "sqlite3 file://localhost/etc/shadow 'SELECT 1;'",
  ])("preserves sensitive database, init, redirect and substitution checks: %s", (command) => {
    for (const readFence of [false, true]) expect(policy(command, readFence)?.kind).toBe("sensitive-path");
  });

  it.each([
    "SELECT readfile('/etc/shadow');",
    'SELECT "readfile" /* separator */ (\'/etc/shadow\');',
    "SELECT [readfile]('/etc/shadow');",
    "SELECT `writefile`('/etc/shadow', 'data');",
    "ATTACH /* comment */ DATABASE '/etc/shadow' AS other;",
    "ATTACH 'file:/etc/%73hadow?mode=ro' AS other;",
    "VACUUM main INTO '/etc/shadow';",
    "PRAGMA main.temp_store_directory('/etc/shadow');",
    ".read /etc/shadow",
    ".output /etc/shadow",
    ".once '/etc/shadow'",
    ".log /etc/shadow",
    ".backup /etc/shadow",
    ".restore main /etc/shadow",
    ".open --readonly /etc/shadow",
  ])("extracts sensitive files from program operands: %s", (program) => {
    expect(policy(call(program))?.kind).toBe("sensitive-path");
    expect(policy(`sqlite3 -cmd ${shellQuote(program)} sample.db`)?.kind).toBe("sensitive-path");
  });

  it.each([
    "sqlite3 ../outside/database.db 'SELECT 1;'",
    "sqlite3 --init ../outside/init.sql sample.db 'SELECT 1;'",
    "sqlite3 sample.db 'SELECT 1;' > ../outside/report",
    "sqlite3 'file:../outside/database.db?mode=ro' 'SELECT 1;'",
  ])("retains the write boundary even with wider reads: %s", (command) => {
    for (const readFence of [false, true]) expect(policy(command, readFence)?.kind).toBe("sandbox-boundary");
  });

  it("resolves extracted filenames through symlinks and URI decoding", () => {
    symlinkSync(outside, join(cwd, "linked"), "junction");
    for (const command of [
      "sqlite3 file:linked/database.db 'SELECT 1;'",
      call("SELECT readfile('linked/input.txt');"),
      call("ATTACH 'file:linked/database.db' AS other;"),
      call("SELECT writefile('linked/output.txt', 'data');"),
      call(".output linked/output.txt"),
    ]) expect(policy(command)?.kind).toBe("sandbox-boundary");
  });

  it("keeps memory database names as filenames in explicit file-loading modes", () => {
    symlinkSync(outside, join(cwd, ":memory:"), "junction");
    expect(policy("sqlite3 :memory: 'SELECT 1;'")).toBeNull();
    for (const command of [
      "sqlite3 -deserialize :memory: 'SELECT 1;'",
      "sqlite3 :memory: -zip 'SELECT 1;'",
      call(".open --deserialize :memory:"),
    ]) expect(policy(command)?.kind).toBe("sandbox-boundary");
  });

  it.each([
    "sqlite3 -unknown value sample.db 'SELECT 1;'",
    "sqlite3 -separator=/etc/shadow sample.db 'SELECT 1;'",
    "sqlite3 -cmdSELECT sample.db",
    "sqlite3 -init",
    "sqlite3 -lookaside 128",
    "sqlite3 -A xf sample.db",
    "sqlite3 -backslash sample.db 'SELECT 1;'",
    'sqlite3 sample.db "$PROGRAM"',
    'sqlite3 sample.db "SELECT $PROGRAM;"',
    "sqlite3 sample.db /etc/query.sql",
    "sqlite3 file:sample%00.db 'SELECT 1;'",
    "sqlite3 file://remote.example/sample.db 'SELECT 1;'",
    "sqlite3 file:bad%XY.db 'SELECT 1;'",
    "sqlite3 file:sample.db?mode=ro 'SELECT 1;'",
    "sqlite3 --deserialize file:sample.db 'SELECT 1;'",
    "sqlite3 file:sample.db --zip 'SELECT 1;'",
    "sqlite3 '~/sample.db' 'SELECT 1;'",
    "sqlite3 input.sql 'SELECT 1;'",
    "sqlite3 input.txt 'SELECT 1;'",
  ])("does not infer authority for unmodelled or incomplete argv: %s", (command) => {
    expect(policy(command)?.kind).toBe("dynamic-path");
  });

  it.each([
    "SELECT readfile('/etc/' || 'shadow');",
    "SELECT writefile(name, 'bytes') FROM files;",
    'SELECT readfile("filename") FROM files;',
    "ATTACH $database AS other;",
    "VACUUM INTO (SELECT name FROM files);",
    "SELECT edit('data');",
    "SELECT eval('SELECT 1;');",
    "SELECT load_extension('extension');",
    "SELECT * FROM fsdir('/etc');",
    "SELECT * FROM fsdir WHERE dir='/etc';",
    "CREATE VIRTUAL TABLE files USING csv(filename='/etc/shadow');",
    ".load extension",
    ".cd ../outside",
    ".parameter set @path (readfile('/etc/shadow'))",
    ".archive --extract",
    ".read '|printf SELECT'",
    '.read "\\057etc/shadow"',
    ".once -e",
    ".out /etc/shadow",
    ".save --append file.db",
    ".open --deserialize file:sample.db",
    ".open '~/sample.db'",
  ])("refuses effects requiring runtime program or path interpretation: %s", (program) => {
    expect(policy(call(program))?.kind).toBe("dynamic-path");
  });

  it.each([".shell sudo printf blocked", ".system sudo printf blocked", ".output '|sudo printf blocked'"])(
    "feeds embedded commands through structural checks: %s", (program) => {
      expect(new BashAstValidator({ mode: "deny" }).validate("bash", { command: call(program) }).decision).toBe("deny");
    },
  );

  it("retains path checks for shell commands carried by the program", () => {
    for (const program of [".shell cat /etc/shadow", ".system cat /etc/shadow", ".output '|cat /etc/shadow'"]) {
      expect(policy(call(program))).not.toBeNull();
    }
  });

  it("requires exact program expansion without promoting unknown formatting data to code", () => {
    const validator = new BashAstValidator({ mode: "deny" });
    expect(validator.validate("bash", { command: 'sqlite3 -nullvalue "$DATA" sample.db "SELECT 1;"' }).decision).toBe("allow");
    expect(validator.validate("bash", { command: 'sqlite3 sample.db "SELECT $PROGRAM;"' }).decision).toBe("deny");
  });
});
