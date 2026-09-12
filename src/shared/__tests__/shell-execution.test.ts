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

  it("rejects syntax instead of returning a partial program",()=>{
    for(const command of ["if", "for x in y; do", "printf '","cat <<EOF\ndata"]){expect(analyzeShell(command).ok).toBe(false);}
  });
});
