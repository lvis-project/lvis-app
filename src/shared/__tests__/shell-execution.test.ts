import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeShell } from "../shell-analysis.js";
import { inspectShellExecution } from "../shell-execution.js";
import { inspectEmbeddedShellPrograms } from "../../tools/shell-path-policy.js";

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, {recursive:true, force:true}); });
function fixture() {
  const cwd=realpathSync.native(mkdtempSync(join(tmpdir(),"shell-state-"))); fixtures.push(cwd);
  for(const name of ["safe","other","deep/nested"])mkdirSync(join(cwd,name),{recursive:true});
  const environment={PATH:"/usr/bin:/bin",HOME:cwd,LC_ALL:"C",TARGET:"parent",A:"parent",B:"parent-b"};
  return {cwd,environment};
}
function emitted(command: string, cwd: string, environment: Record<string,string>): string[] {
  const values:string[]=[];
  inspectShellExecution(command,cwd,{dialect:"bash",environment},{path(){},command(event){
    if(event.argv[0]==="printf" && event.argv[1]==="%s\\0") {
      for(const argument of event.argv.slice(2)){expect(argument).not.toBeUndefined();values.push(argument!);}
    }
    inspectEmbeddedShellPrograms(event);
  }});
  return values;
}
function native(command:string,cwd:string,env:Record<string,string>):string[] {
  const result=spawnSync("/bin/bash",["--noprofile","--norc","-c",command],{cwd,env,timeout:3000});
  expect(result.error).toBeUndefined();expect(result.status, result.stderr.toString()).toBe(0);
  const output=result.stdout.toString("utf8");expect(output.endsWith("\0")).toBe(true);
  return output.slice(0,-1).split("\0");
}

describe.skipIf(process.platform==="win32")("typed shell execution and native arguments",()=>{
  it.each([
    "printf '%s\\0' '$TARGET' \"$TARGET\" \\$TARGET '%CD%' '$(literal)' '`literal`'",
    String.raw`printf '%s\0' "$PWD/"'$TARGET/file' '' 'a b' 'x=y' '@literal' 'r{m}'`,
    "printf '%s\\0' a\\\nb \"c\\\nd\" 'e\\\nf'",
    "printf '%s\\0' one # keep \\\nprintf '%s\\0' two",
    "printf '%s\\0' '한글😀' a\rb \"x\r\ny\"",
    String.raw`printf '%s\0' $'a\nb' $'\x41' $'^\s'`,
    String.raw`TARGET=./safe; printf '%s\0' "$TARGET"; ( TARGET=./other ); printf '%s\0' "$TARGET"`,
    String.raw`for TARGET in ./safe ./other; do printf '%s\0' "$TARGET"; done; printf '%s\0' "$TARGET"`,
    String.raw`for TARGET in ./safe; do for TARGET in ./other; do :; done; done; printf '%s\0' "$TARGET"`,
    String.raw`for TARGET in ./safe; do (for TARGET in ./other; do :; done); done; printf '%s\0' "$TARGET"`,
    String.raw`TARGET=./safe; if false; then TARGET=./other; fi; printf '%s\0' "$TARGET"`,
    String.raw`TARGET=./safe; false && TARGET=./other; printf '%s\0' "$TARGET"`,
    String.raw`TARGET=./safe; true || TARGET=./other; printf '%s\0' "$TARGET"`,
    String.raw`cd deep/nested; (cd ../..); printf '%s\0' "$PWD"`,
    String.raw`HOME=./safe printf '%s\0' "$HOME"; printf '%s\0' "$HOME"`,
    String.raw`HOME=./safe bash -c 'printf "%s\0" "$HOME"'`,
    String.raw`TARGET=./safe; emit(){ printf '%s\0' "$TARGET" "$1"; }; TARGET=./other emit value; printf '%s\0' "$TARGET"`,
    String.raw`printf '%s\0' [ ] [abc ./safe/file[ ./safe/file[abc`,
    String.raw`printf '%s\0' \[a] '[a]' "[a]" [a\] [a"]" [a']' ["abc"`,
    String.raw`printf '%s\0' 'prefix['a] "prefix["a] prefix\[a] [a\\`,
  ])("preserves native argument bytes and scope: %s",command=>{
    const {cwd,environment}=fixture();expect(emitted(command,cwd,environment)).toEqual(native(command,cwd,environment));
  });

  it.each([
    [String.raw`./safe/[ab]`, ["./safe/a", "./safe/b"]],
    [String.raw`./safe/["a"]`, ["./safe/a"]],
    [String.raw`./safe/['!']`, ["./safe/!"]],
    [String.raw`./safe/[\]]`, ["./safe/]"]],
    [String.raw`./safe/[]]`, ["./safe/]"]],
    [String.raw`./safe/[!b]`, ["./safe/!", "./safe/]", "./safe/a"]],
    [String.raw`./safe/[^b]`, ["./safe/!", "./safe/]", "./safe/a"]],
    [String.raw`./safe/[[:alpha:]]`, ["./safe/a", "./safe/b"]],
    [String.raw`./safe/[$TARGET]`, ["./safe/a"]],
  ])("keeps native bracket expansion unresolved: %s", (operand, expected) => {
    const { cwd, environment } = fixture();
    for (const name of ["a", "b", "!", "]"]) writeFileSync(join(cwd, "safe", name), "fixture");
    const command = `TARGET=a; printf '%s\\0' ${operand}`;
    expect(native(command, cwd, environment)).toEqual(expected);
    const arguments_: (string | undefined)[] = [];
    inspectShellExecution(command, cwd, { dialect: "bash", environment }, {
      path() {}, command(event) { if (event.argv[0] === "printf") arguments_.push(...event.argv.slice(2)); },
    });
    expect(arguments_).toEqual([undefined]);
  });

  it.each(["[]", "[!]", "[^]", "[[:alpha:]", "[[:unknown:]]", "[a/b]"])(
    "keeps closed ambiguous bracket forms unresolved: %s", (operand) => {
      const { cwd, environment } = fixture();
      expect(() => inspectShellExecution(operand, cwd, { dialect: "bash", environment }, {
        path() {}, command() {},
      })).toThrow("unresolved executed command");
    },
  );

  it("keeps heredoc code distinct from quoted data",()=>{
    const {cwd,environment}=fixture();
    for(const [header,body,inner]of [
      ["EOF","$(printf '%s' active)",true],
      ["'EOF'","$(printf '%s' literal)",false],
      ["EOF","`printf '%s' active`",true],
      ["EOF","\\`printf '%s' literal\\`",false],
    ] as const){
      const command=`cat <<${header}\n${body}\nEOF\n`;
      const calls:string[]=[];inspectShellExecution(command,cwd,{dialect:"bash",environment},{path(){},command:e=>{calls.push(e.argv[0]!);}});
      expect(calls.includes("printf")).toBe(inner);
      const result=spawnSync("/bin/bash",["--noprofile","--norc","-c",command],{cwd,env:environment,timeout:3000,encoding:"utf8"});
      expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe(inner?"active\n":body.replaceAll("\\`","`")+"\n");
    }
  });

  it("retains cwd and loop state at a known lexical break", () => {
    const { cwd, environment } = fixture();
    mkdirSync(join(cwd, "stage/first"), { recursive: true });
    const command = String.raw`cd stage; for item in first stop after; do if [ "$item" = stop ]; then break; fi; cd "$item"; done; printf '%s\0' "$PWD" "$item"`;
    expect(emitted(command, cwd, environment)).toEqual([join(cwd, "stage/first"), "stop"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("propagates break through nested lexical loops and stops the remaining bodies", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`for outer in a b; do for inner in x y; do break 2; printf '%s\0' inner-dead; done; printf '%s\0' outer-dead; done; printf '%s\0' complete`;
    expect(emitted(command, cwd, environment)).toEqual(["complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it.each([
    String.raw`for item in one; do break && printf '%s\0' dead; done; printf '%s\0' complete`,
    String.raw`for item in one; do break || printf '%s\0' dead; done; printf '%s\0' complete`,
    String.raw`for item in one; do ! break; printf '%s\0' dead; done; printf '%s\0' complete`,
  ])("propagates break through list status operators: %s", command => {
    const { cwd, environment } = fixture();
    expect(emitted(command, cwd, environment)).toEqual(["complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it.each([
    String.raw`while true; do cd safe; break; cd ../other; done; printf '%s\0' "$PWD"`,
    String.raw`until false; do cd safe; break; cd ../other; done; printf '%s\0' "$PWD"`,
  ])("retains state when break exits a conditional loop: %s", command => {
    const { cwd, environment } = fixture();
    expect(emitted(command, cwd, environment)).toEqual([join(cwd, "safe")]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("consumes a break from the while condition itself", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`while break; do printf '%s\0' dead; done; printf '%s\0' complete`;
    expect(emitted(command, cwd, environment)).toEqual(["complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("uses the outermost local loop for a proven over-depth break count", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`for item in a b; do break 9223372036854775807; printf '%s\0' dead; done; printf '%s\0' complete`;
    expect(emitted(command, cwd, environment)).toEqual(["complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("accepts a positive decimal break count with leading zeroes", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`for item in a b; do break 0001; printf '%s\0' dead; done; printf '%s\0' complete`;
    expect(emitted(command, cwd, environment)).toEqual(["complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("keeps both break and non-break states for an unknown condition", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`for item in one; do if [ "$UNKNOWN" = stop ]; then break; fi; cd safe; done; printf '%s\0' "$PWD"`;
    expect(new Set(emitted(command, cwd, environment))).toEqual(new Set([cwd, join(cwd, "safe")]));
  });

  it("keeps the redirect-failure branch that does not execute break", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`for item in one; do break > ./break-output; cd safe; done; printf '%s\0' "$PWD"`;
    expect(new Set(emitted(command, cwd, environment))).toEqual(new Set([cwd, join(cwd, "safe")]));
  });

  it("retains double-bracket origin instead of applying scalar test status", () => {
    const { cwd, environment } = fixture();
    const doubleBracket = String.raw`if [[ foo = f* ]]; then printf '%s\0' yes; else printf '%s\0' no; fi`;
    const scalarTest = String.raw`if test foo = 'f*'; then printf '%s\0' yes; else printf '%s\0' no; fi`;
    expect(new Set(emitted(doubleBracket, cwd, environment))).toEqual(new Set(["yes", "no"]));
    expect(emitted(scalarTest, cwd, environment)).toEqual(["no"]);
    expect(native(doubleBracket, cwd, environment)).toEqual(["yes"]);
    expect(native(scalarTest, cwd, environment)).toEqual(["no"]);
  });

  it.each([
    [String.raw`if test 9007199254740993 -gt 9007199254740992; then printf '%s\0' exact; else printf '%s\0' rounded; fi`, "exact"],
    [String.raw`if test 9223372036854775807 -eq 9223372036854775807; then printf '%s\0' max; else printf '%s\0' wrong; fi`, "max"],
    [String.raw`if test -9223372036854775808 -lt 0; then printf '%s\0' min; else printf '%s\0' wrong; fi`, "min"],
  ])("matches native integer truth inside the proven range: %s", (command, expected) => {
    const { cwd, environment } = fixture();
    expect(emitted(command, cwd, environment)).toEqual([expected]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it("retains both branches above the proven native integer range", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`if test 9223372036854775808 -eq 9223372036854775808; then printf '%s\0' true-branch; else printf '%s\0' false-branch; fi`;
    expect(new Set(emitted(command, cwd, environment))).toEqual(new Set(["true-branch", "false-branch"]));
  });

  it.each([
    String.raw`for item in one; do (break); done`,
    String.raw`for item in one; do value=$(break); done`,
    String.raw`for item in one; do break | cat; done`,
    String.raw`breaker(){ break; }; for item in one; do breaker; done`,
    String.raw`for item in one; do bash -c 'break'; done`,
  ])("does not carry a break across an execution-environment boundary: %s", command => {
    const { cwd, environment } = fixture();
    expect(() => emitted(command, cwd, environment)).toThrow("break has no local enclosing loop");
  });

  it("allows a function to consume break from its own lexical loop", () => {
    const { cwd, environment } = fixture();
    const command = String.raw`breaker(){ for item in one; do break; printf '%s\0' dead; done; printf '%s\0' function-complete; }; breaker`;
    expect(emitted(command, cwd, environment)).toEqual(["function-complete"]);
    expect(emitted(command, cwd, environment)).toEqual(native(command, cwd, environment));
  });

  it.each([
    "break",
    "for item in one; do break 0; done",
    "for item in one; do break -1; done",
    "for item in one; do break +1; done",
    `for item in one; do break "$UNKNOWN_BREAK"; done`,
    "for item in one; do break 9223372036854775808; done",
    `for item in one; do break ${"9".repeat(2_000)}; done`,
    "for item in one; do break 1 2; done",
  ])("rejects an invalid or unproven break target: %s", command => {
    const { cwd, environment } = fixture();
    expect(() => emitted(command, cwd, environment)).toThrow(/break/);
  });

  it("pins the selected native shell rejecting the first integer above the bound", () => {
    const { cwd, environment } = fixture();
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", "for item in one; do break 9223372036854775808; done"], {
      cwd, env: environment, encoding: "utf8", timeout: 3_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });

  it("rejects syntax instead of returning a partial program",()=>{
    for(const command of ["if", "for x in y; do", "printf '","cat <<EOF\ndata"]){expect(analyzeShell(command).ok).toBe(false);}
  });
});
