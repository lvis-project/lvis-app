import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";
import { shellQuote } from "../../lib/shell-resolver.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-authority-"))); roots.push(root);
  const cwd = join(root, "allowed"), outside = join(root, "outside");
  mkdirSync(cwd); mkdirSync(outside); mkdirSync(join(cwd, "safe")); mkdirSync(join(cwd, "deep/nested"), { recursive: true });
  writeFileSync(join(cwd, "source"), "copied bytes\0\xff", "binary");
  writeFileSync(join(outside, "file"), "sentinel");
  const environment = { PATH: "/usr/bin:/bin", HOME: cwd, PWD: cwd, LC_ALL: "C" };
  const facts = { dialect: "bash" as const, environment };
  const policy = (command: string) => findShellPathPolicyViolation(command, cwd, cwd, [], true, facts);
  const native = (command: string) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, env: environment, encoding: "utf8", timeout: 3000 });
  return { cwd, outside, facts, policy, native };
}

describe.skipIf(process.platform === "win32")("literal bytes and scoped shell path authority", () => {
  it.each(["direct", "nested", "wrapped"])("confines an unknown absolute executable with wide reads: %s", (form) => {
    const { cwd, outside, facts, native } = fixture();
    const script = join(outside, "owned-program");
    writeFileSync(script, "#!/bin/bash\nprintf executed > \"$1\"\n", { mode: 0o700 });
    const call = `${shellQuote(script)} ${shellQuote(join(cwd, "result"))}`;
    const command = form === "nested" ? `sh -c ${shellQuote(call)}` : form === "wrapped" ? `env ${call}` : call;
    // The native control uses only this fixture's files. Its effect is execution,
    // even though reading this same script would be admitted with wide reads.
    expect(native(command).status).toBe(0);
    expect(readFileSync(join(cwd, "result"), "utf8")).toBe("executed");
    expect(findShellPathPolicyViolation(command, cwd, cwd, [], false, facts)?.kind).toBe("sandbox-boundary");
    expect(findShellPathPolicyViolation(`cat ${shellQuote(script)}`, cwd, cwd, [], false, facts)).toBeNull();
  });

  it("preserves local executable and absolute read-only command admission", () => {
    const { cwd, facts, native } = fixture();
    const script = join(cwd, "owned-program");
    writeFileSync(script, "#!/bin/bash\nprintf executed\n", { mode: 0o700 });
    for (const command of [shellQuote(script), "/bin/cat source"]) {
      expect(findShellPathPolicyViolation(command, cwd, cwd, [], false, facts)).toBeNull();
      expect(native(command).status).toBe(0);
    }
  });

  it.each(["$PWD", "%CD%", "$(literal)", "`literal`", "@literal", "a=b", "space name", "r{m}"])("copies to the exact quoted directory %s", (name) => {
    const { cwd, policy, native } = fixture(); mkdirSync(join(cwd, name));
    const command = `cp source ${shellQuote(name + "/file")}`;
    expect(policy(command)).toBeNull(); const result = native(command);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(cwd, name, "file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it("preserves mixed literal dollars and an active variable", () => {
    const { cwd, policy, native } = fixture(); mkdirSync(join(cwd, "$PWD"));
    const command = 'TARGET=file; cp source \'$PWD/\'"$TARGET"';
    expect(policy(command)).toBeNull(); expect(native(command).status).toBe(0);
    expect(readFileSync(join(cwd, "$PWD/file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each(["$PWD", "%CD%", "@literal", "a=b", "bare-link"])("checks the real destination behind %s", (name) => {
    const { cwd, outside, policy, native } = fixture(); symlinkSync(outside, join(cwd, name));
    const command = `cp source ${shellQuote(name + "/file")}`;
    // The independent native control proves which owned sibling would be touched.
    expect(native(command).status).toBe(0); expect(readFileSync(join(outside, "file"))).toEqual(readFileSync(join(cwd, "source")));
    writeFileSync(join(outside, "file"), "sentinel");
    expect(policy(command)?.kind).toBe("sandbox-boundary");
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("sentinel");
  });

  it.each([
    'TARGET="$(printf ../outside)"; printf "%s" "for TARGET in ./safe; do"; cp source "$TARGET/file"',
    'TARGET="$(printf ../outside)"; cp source "$TARGET/file"; for TARGET in ./safe; do :; done',
    'for TARGET in ./safe; do TARGET=../outside; done; cp source "$TARGET/file"',
    'for TARGET in ./safe; do for TARGET in ../outside; do :; done; done; cp source "$TARGET/file"',
    'cd deep/nested; cd ../..; ( cd deep/nested ); cp source ../outside/file',
  ])("does not grant authority from a different binding or scope: %s", (command) => {
    const { cwd, outside, policy, native } = fixture();
    expect(native(command).status).toBe(0); expect(readFileSync(join(outside, "file"))).toEqual(readFileSync(join(cwd, "source")));
    writeFileSync(join(outside, "file"), "sentinel"); expect(policy(command)).not.toBeNull();
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("sentinel");
  });

  it.each([
    'TARGET=./safe; while TARGET=../outside; false; do :; done; cp source "$TARGET/file"',
    'TARGET=./safe; until TARGET=../outside; true; do :; done; cp source "$TARGET/file"',
    'TARGET=./safe; UNUSED=$(false) || TARGET=../outside; cp source "$TARGET/file"',
    'TARGET=./safe; UNUSED=$(true) && TARGET=../outside; cp source "$TARGET/file"',
    'mkdir new; cd new && cp ../source ../../outside/file',
    '(mkdir new); cd new && cp ../source ../../outside/file',
    'UNUSED=$(mkdir new); cd new && cp ../source ../../outside/file',
    'mkdir new | cat; cd new && cp ../source ../../outside/file',
    'mkdir new & wait; cd new && cp ../source ../../outside/file',
    'cp(){ :; }; unset cp; cp source ../outside/file',
    'cp(){ :; }; unset -f cp; cp source ../outside/file',
    'read(){ TARGET=../outside; }; TARGET=./safe; read; cp source "$TARGET/file"',
    'for TARGET in ../outside ./safe; do break; done; cp source "$TARGET/file"',
  ])("preserves condition status and shared effects: %s", (command) => {
    const { cwd, outside, policy, native } = fixture();
    // Policy sees the initial filesystem, before any fixture command executes.
    expect(policy(command)).not.toBeNull();
    expect(native(command).status).toBe(0);
    expect(readFileSync(join(outside, "file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each([
    'TARGET=./safe; while TARGET=./safe; false; do TARGET=../outside; done; cp source "$TARGET/file"',
    'TARGET=./safe; until TARGET=./safe; true; do TARGET=../outside; done; cp source "$TARGET/file"',
    'TARGET=./safe; UNUSED=$(true) || TARGET=../outside; cp source "$TARGET/file"',
    'TARGET=./safe; UNUSED=$(false) && TARGET=../outside; cp source "$TARGET/file"',
    'TARGET=./safe; export TARGET; bash -c \'cp source "$TARGET/file"\'',
    'TARGET=./safe; readonly TARGET; cp source "$TARGET/file"',
  ])("preserves pure status facts and named declarations: %s", (command) => {
    const { cwd, policy, native } = fixture();
    expect(policy(command)).toBeNull();
    expect(native(command).status).toBe(0);
    expect(readFileSync(join(cwd, "safe/file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each(['cp(){ :; }; cp source ../outside/file', 'cp=present; cp(){ :; }; unset cp; cp source ../outside/file'])("distinguishes function and variable namespaces: %s", (command) => {
    const { outside, policy, native } = fixture();
    expect(policy(command)).toBeNull(); expect(native(command).status).toBe(0);
    expect(readFileSync(join(outside, "file"), "utf8")).toBe("sentinel");
  });

  it("follows a symlink before parent traversal in a file operand", () => {
    const { cwd, outside, policy, native } = fixture();
    mkdirSync(join(outside, "deep")); symlinkSync(join(outside, "deep"), join(cwd, "link"));
    const command = "cp source link/../file";
    expect(policy(command)?.kind).toBe("sandbox-boundary"); expect(native(command).status).toBe(0);
    expect(readFileSync(join(outside, "file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it("uses the selected cd logical/physical and end-of-options contracts", () => {
    const { cwd, outside, policy, native } = fixture();
    mkdirSync(join(outside, "deep")); symlinkSync(join(outside, "deep"), join(cwd, "link"));
    mkdirSync(join(cwd, "-P"));
    for (const command of ["cd -L link/.. && cp source safe/file", "cd -- -P && cp ../source file"]) {
      expect(policy(command)).toBeNull(); expect(native(command).status).toBe(0);
    }
    const physical = `cd -P link/.. && cp ${shellQuote(join(cwd, "source"))} file`;
    expect(policy(physical)?.kind).toBe("sandbox-boundary"); expect(native(physical).status).toBe(0);
    expect(readFileSync(join(outside, "file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each([
    'for TARGET in ./safe; do (for TARGET in ../outside; do :; done); done; cp source "$TARGET/file"',
    'TARGET=./safe; if false; then TARGET=../outside; fi; cp source "$TARGET/file"',
    'TARGET=./safe; printf "%s" "for TARGET in ../outside; do"; cp source "$TARGET/file"',
  ])("retains the actual safe binding: %s", (command) => {
    const { cwd, policy, native } = fixture(); expect(policy(command)).toBeNull(); expect(native(command).status).toBe(0);
    expect(readFileSync(join(cwd, "safe/file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each(["command cp -r safe other", "env cp -r safe other", "for item in safe; do command cp -r \"$item\" other; done"])("retains the recursive traversal gate through %s", (command) => {
    expect(fixture().policy(command)?.kind).toBe("recursive-traversal");
  });

  it("uses command positions and every public command field for structural rules", () => {
    const { cwd, facts, native } = fixture(); const validator = new BashAstValidator();
    const data = "printf '%s' 'sudo eval r{m}'";
    expect(native(data).stdout).toBe("sudo eval r{m}");
    expect(validator.validate("bash", { command: data }, { cwd, facts }).decision).toBe("allow");
    for (const field of ["command", "cmd", "script", "shellCommand"]) {
      for (const command of ["sudo printf control", "eval 'printf control'", "r''m -rf /", String.raw`r\m -rf /`, "{rm,echo} -rf /"]) {
        expect(validator.validate("bash", { command: data, [field]: command }, { cwd, facts }).decision).toBe("deny");
      }
    }
  });

  it.each([
    `TARGET=./safe; export TARGET; sh -c 'cp source "$TARGET/file"'`,
    `sh -c 'TARGET=./safe :; cp source "$TARGET/file"'`,
    `TARGET=./safe; export TARGET; bash -c 'cp source "$TARGET/file"'`,
  ])("preserves an exported child binding in %s", (command) => {
    const { cwd, policy, native } = fixture();
    expect(policy(command)).toBeNull(); expect(native(command).status).toBe(0);
    expect(readFileSync(join(cwd, "safe/file"))).toEqual(readFileSync(join(cwd, "source")));
  });

  it.each([
    `TARGET=./safe; bash -c 'cp source "$TARGET/file"'`,
    `TARGET=./safe; sh -c 'TARGET=../outside :; cp source "$TARGET/file"'`,
    `TARGET=./safe; export TARGET; sh -c 'TARGET=../outside unset TARGET; cp source "$TARGET/file"'`,
    `env BASH_ENV=./startup bash -c 'cp source safe/file'`,
  ])("does not infer child authority from parent-only or altered startup state: %s", (command) => {
    expect(fixture().policy(command)).not.toBeNull();
  });

  it("checks a curl format file in supported separate and attached forms", () => {
    const { outside, policy, native } = fixture();
    writeFileSync(join(outside, "format"), "owned format");
    for (const option of ["-w @../outside/format", "--write-out @../outside/format", "-w@../outside/format"]) {
      const command = `curl -s -o /dev/null ${option} file:///dev/null`;
      expect(policy(command)?.kind).toBe("sandbox-boundary");
      const result = native(command);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe("owned format");
    }
  });
});

describe.skipIf(process.platform === "win32")("data expansion effects and path authority", () => {
  it.each([
    ['echo "sum=$((1+2))"', "sum=3\n"],
    ['n=3; echo "sum=$((n + 2))"', "sum=5\n"],
    ['echo "${VALUE:-fallback}"', "fallback\n"],
    ['VALUE=inside; echo "${VALUE:-$(printf unused)}"', "inside\n"],
    ['VALUE=inside; echo "${VALUE:+selected}"', "selected\n"],
    ['unset VALUE; echo "${VALUE-other}"', "other\n"],
    ['VALUE=; echo "${VALUE-other}"', "\n"],
    ['VALUE=; echo "${VALUE:-other}"', "other\n"],
  ])("allows data while preserving native expansion: %s", (command, expected) => {
    const { policy, native, cwd, facts } = fixture();
    expect(policy(command)).toBeNull();
    expect(new BashAstValidator().validate("bash", {command}, {cwd, facts}).decision).toBe("allow");
    const observed=native(command);expect(observed.status,observed.stderr).toBe(0);expect(observed.stdout).toBe(expected);
  });
  it.each([
    'cp source "$((1+2))"',
    'cp source "${UNKNOWN:-../outside/file}"',
    'echo "${UNKNOWN:-$(cp source ../outside/file)}"',
    'VALUE=inside; echo "${VALUE:+$(cp source ../outside/file)}"',
    'echo "$((TARGET=3))"',
    'VALUE="arbitrary_expression"; echo "$((VALUE))"',
  ])("does not convert an unknown value or an active effect into path authority: %s", command => {
    const {policy, outside}=fixture();expect(policy(command)).not.toBeNull();
    expect(readFileSync(join(outside,"file"),"utf8")).toBe("sentinel");
  });
  it("does not inspect an unselected default operand as executed",()=>{
    const {policy,native,outside}=fixture();const command='VALUE=inside; echo "${VALUE:-$(cp source ../outside/file)}"';
    expect(policy(command)).toBeNull();expect(native(command).stdout).toBe("inside\n");
    expect(readFileSync(join(outside,"file"),"utf8")).toBe("sentinel");
  });
});
