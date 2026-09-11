import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzeShell, type ShellStatement } from "../shell-analysis.js";
import { tokenizeShell } from "../shell-tokenizer.js";
function statements(command:string):ShellStatement[]{const a=analyzeShell(command);expect(a.ok).toBe(true);return a.ok&&a.program.kind==="sequence"?[...a.program.statements]:[];}
function substitutions(command:string):string[]{return tokenizeShell(command).leaves.slice(1).map(leaf=>leaf.raw);}
describe("typed heredoc data and execution roles",()=>{
  it.each([
    ":%s/^first$/last/\nwq", "printf 'path/to/data' # ordinary text", "unmatched ' quote and # data",
    "literal \\$(command) and \\`command\\`", "$'literal' and a standalone $",
  ])("keeps body data attached to its redirect without interpreting commands: %s",body=>{
    const command=`cat > ./output <<END\n${body}\nEND`;
    expect(tokenizeShell(command).leaves).toHaveLength(1);
    const node=statements(command)[0]!;expect(node.kind).toBe("command");
    if(node.kind==="command"){expect(node.redirects[1]!.data).toBeDefined();expect(node.redirects[0]!.target?.source.raw).toBe("./output");}
  });
  it.each(["printf '$(printf expanded)'",'# "$(printf expanded)"',"printf '`printf expanded`'"])("finds executed substitutions beneath body data: %s",body=>{
    expect(substitutions(`cat <<END\n${body}\nEND`)).toEqual(["printf expanded"]);
  });
  it.skipIf(process.platform==="win32")("matches actual expansion beneath body quotes and comments",()=>{
    const command="cat <<END\nprintf '$(printf first)' # $(printf second)\nEND";
    expect(execFileSync("/bin/bash",["-c",command],{encoding:"utf8"})).toBe("printf 'first' # second\n");
    expect(substitutions(command)).toEqual(["printf first","printf second"]);
  });
  it.each(["printf \\); printf later","printf ')'; printf later"])("keeps a complete command substitution: %s",body=>{
    expect(substitutions(`cat <<END\n'$(${body})'\nEND`)).toEqual([body.slice(0,body.indexOf(';')),"printf later"]);
  });
  it("retains dynamic value provenance without interpreting the value as code",()=>{
    const node=statements("cat <<END\n$VALUE\nEND")[0]!;expect(node.kind).toBe("command");
    if(node.kind==="command")expect(node.redirects[0]!.data?.parts).toContainEqual({kind:"parameter",name:"VALUE",quoted:true});
  });
  it.skipIf(process.platform==="win32").each([
    ["cat <<END\nprintf '$(printf witnessed)'","printf 'witnessed'\n"],
    ["cat <<$END\nprintf '$(printf witnessed)'\n$END","printf 'witnessed'\n"],
  ])("records native syntax outside the strict parser contract without returning partial authority: %s",(command,expected)=>{
    expect(execFileSync("/bin/bash",["-c",command],{encoding:"utf8",stdio:["pipe","pipe","ignore"]})).toBe(expected);
    expect(analyzeShell(command).ok).toBe(false);
  });
  it.each(["sh","python3 -","cat | sh","env cat"])("retains typed stdin for the actual consumer: %s",header=>{
    const command=`${header} <<END\ncat /etc/shadow\nEND`;
    expect(analyzeShell(command).ok).toBe(true);expect(tokenizeShell(command).leaves.some(leaf=>leaf.hasInputRedirect)).toBe(true);
    // The consumer/pipe authority is checked by the execution inspector, not a redacted string.
    expect(tokenizeShell(command).leaves.every(leaf=>!leaf.argv.includes("/etc/shadow"))).toBe(true);
  });
  it.each(["|","||","&&",";","&"])("preserves the owner of stdin across a control operator: %s",operator=>{
    const command=`cat <<END ${operator}\nprintf witnessed\nEND\nsh`;
    const leaves=tokenizeShell(command).leaves;expect(leaves.map(x=>x.argv[0])).toEqual(["cat","sh"]);
    expect(leaves[0]!.hasInputRedirect).toBe(true);expect(leaves[1]!.hasInputRedirect).toBe(false);
  });
  it.skipIf(process.platform==="win32")("preserves a pipeline that resumes after its heredoc",()=>{
    const command="cat <<END |\nprintf witnessed\nEND\nsh";
    expect(execFileSync("/bin/bash",["-c",command],{encoding:"utf8"})).toBe("witnessed");
    expect(statements(command)[0]!.kind).toBe("pipeline");
  });
  it.each(["cat <<< END","cat <<< 'END'","printf '<<< END'","printf \\<\\<\\< END"])("keeps later commands after literal or here-string input: %s",header=>{
    expect(tokenizeShell(`${header}\nprintf harmless > ./output\nEND`).leaves.some(x=>x.redirectTargets.includes("./output"))).toBe(true);
  });
  it.skipIf(process.platform==="win32")("keeps carriage returns in bare delimiters",()=>{
    const command="cat <<END\r\nEND\nprintf '$(printf witnessed)'\nEND\r";
    expect(execFileSync("/bin/bash",["-c",command],{encoding:"utf8"})).toBe("END\nprintf 'witnessed'\n");
    expect(substitutions(command)).toEqual(["printf witnessed"]);
  });
  it.each([["{","}"],["(",")"]])("retains a group's heredoc before a pipeline: %s",(open,close)=>{
    const command=`${open}\ncat <<END\nprintf witnessed\nEND\n${close} | sh`;
    expect(statements(command)[0]!.kind).toBe("pipeline");
  });
  it.each(["$(unclosed","`unclosed"])("does not create a partial program from unfinished expansion: %s",body=>{
    expect(analyzeShell(`cat <<END\n${body}\nEND`).ok).toBe(false);
  });
  it("consumes multiple bodies in order without opening syntax from body text",()=>{
    const node=statements("cat <<FIRST <<'SECOND'\n<<'FALSE'\nFIRST\nother\nSECOND")[0]!;
    expect(node.kind).toBe("command");if(node.kind==="command")expect(node.redirects.map(x=>x.data?.parts)).toEqual([
      [{kind:"literal",value:"<<'FALSE'\n"}],[{kind:"literal",value:"other\n"}],
    ]);
  });
  it.each([
    "echo hi # <<'X'\nprintf later\nX", "# <<'X'\nprintf later\nX", "echo hi # <<-'X'\nprintf later\nX",
    "curl http://example.test/x#frag <<'A'\nbody\nA\nprintf later", "cat <<'A' # note\nbody\nA\nprintf later",
  ])("retains later execution and distinguishes comments from arguments: %s",command=>{
    expect(tokenizeShell(command).leaves.some(x=>x.argv[0]==="printf"&&x.argv[1]==="later")).toBe(true);
  });
});
