import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tokenizeShell } from "../shell-tokenizer.js";
import { parseShellSyntax } from "../shell-parser.js";
import { analyzeShell, type ShellStatement } from "../shell-analysis.js";
const pair="\\\n";
function commands(node: ShellStatement): string[] {
  switch(node.kind){
    case "command":return [node.source.raw];
    case "sequence":case "pipeline":return node.statements.flatMap(commands);
    case "and":case "or":return [...commands(node.left),...commands(node.right)];
    default:return [];
  }
}
describe("canonical logical input and original spans",()=>{
  it.skipIf(process.platform==="win32").each([
    "first\\\nsecond", "first \\\n second", "'first'\\\n'second'", '"first\\\nsecond"',
    "'first\\\nsecond'", '"first\\\\\nsecond"', "'한글😀' a\\\nb",
  ])("matches actual argument bytes: %s",operands=>{
    const command=`printf '%s\\0' ${operands}`;
    const actual=execFileSync("/bin/bash",["--noprofile","--norc","-c",command],{encoding:"utf8"}).split("\0").slice(0,-1);
    const parsed=tokenizeShell(command);expect(parsed.parseError).toBe(false);
    expect(parsed.leaves[0]!.argv.slice(2)).toEqual(actual);expect(parsed.leaves[0]!.raw).toBe(command);
  });
  it("recognizes joined operators and retains original substitution source",()=>{
    const parsed=tokenizeShell(`printf first &${pair}& printf second`);
    expect(parsed.leaves.map(x=>x.argv)).toEqual([["printf","first"],["printf","second"]]);
    for(const command of [`printf $${pair}(printf value)`,`printf "$${pair}(printf value)"`]){
      const leaf=tokenizeShell(command).leaves[0]!;expect(leaf.hasCommandSubstitution).toBe(true);
      expect(leaf.raw).toBe(command);expect(tokenizeShell(command).leaves[1]!.argv).toEqual(["printf","value"]);
    }
  });
  it("preserves nested single quotes and active parameter metadata",()=>{
    const command=`printf "$(printf 'first${pair}second')" ${pair} tail`;
    expect(tokenizeShell(command).leaves[1]!.argv).toEqual(["printf",`first${pair}second`]);
    expect(tokenizeShell(`grep ${pair} "$PATTERN" ./file`).leaves[0]).toMatchObject({argv:["grep","$PATTERN","./file"],argvHasExpandableDollar:[false,true,false]});
  });
  it.each(["printf first \\\\\nprintf second","printf first \\\r\nprintf second",`printf first # comment ${pair}printf second`])("retains a physical command boundary: %s",command=>{
    expect(tokenizeShell(command).leaves).toHaveLength(2);
  });
  it.skipIf(process.platform==="win32").each([
    [`cat <<'END'\nfirst${pair}second\nEND\nprintf ${pair} done`,`first${pair}second\ndone`],
    [`cat >/dev/null <<END\nEN${pair}D\nprintf witnessed`,"witnessed"],
    [`cat <<END\n'first${pair}second' # data${pair}continued\nEND\nprintf ${pair} later`,"'firstsecond' # datacontinued\nlater"],
    [`cat <<END\n$(printf ${pair} value)\nEND\nprintf ${pair} later`,"value\nlater"],
    [`cat <<-END\nbody\\\\\n\tEND\nprintf ${pair} later`,"body\\\nlater"],
    [`cat <<"E"ND\n$${pair}(printf DATA)\nEND`,`$${pair}(printf DATA)\n`],
  ])("preserves heredoc body mode and later execution: %s",(command,expected)=>{
    expect(execFileSync("/bin/bash",["--noprofile","--norc","-c",command],{encoding:"utf8"})).toBe(expected);
    expect(tokenizeShell(command).parseError).toBe(false);
  });
  it.each([
    `if :; then printf done; f${pair}i`, `for x in a; do printf done; do${pair}ne`,
    `case a in a) printf done;; es${pair}ac`, `printf '%s' "$((1+2)${pair})"`,
    `[[ a = a ]${pair}]`, `printf '%s' @${pair}(a|b)`, `if :; then printf 가😀; f${pair}i`,
  ])("ends a token at its actual original byte boundary: %s",command=>{
    expect(parseShellSyntax(command).End?.Offset).toBe(Buffer.byteLength(command));
  });
  it("retains valid quoted delimiters and later sensitive command bytes",()=>{
    for(const delimiter of ['E"ND"',"\\END"]){
      const command=`cat <<${delimiter}\nEND\ncat /et${pair}c/shadow`;
      const analysis=analyzeShell(command);expect(analysis.ok).toBe(true);
      if(analysis.ok)expect(commands(analysis.program).at(-1)).toBe(`cat /et${pair}c/shadow`);
      expect(tokenizeShell(command).leaves.at(-1)!.argv).toEqual(["cat","/etc/shadow"]);
    }
  });
  it("does not return a partial tree for an unfinished heredoc",()=>{
    expect(analyzeShell(`cat <<END\nstill open${pair}`).ok).toBe(false);
  });
});
