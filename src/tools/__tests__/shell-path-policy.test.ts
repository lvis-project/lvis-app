import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

import {
  validateShellCommandPathPolicy as validateShellCommandPathPolicyWithFence,
  validateShellWorkingDirectory,
} from "../shell-path-policy.js";

/**
 * The policy under its SHIPPED configuration unless a case says otherwise.
 *
 * `permissions.blockReadsOutsideWorkingDirectories` ships OFF: a read operand
 * is bounded by the Layer 0 deny-list alone, while writes and command execution
 * stay confined to `sandboxRoot ∪ extraAllowedDirectories`. Passing `true`
 * re-fences reads and restores the symmetric boundary, which is the only
 * configuration under which a read-only operand outside the root is refused.
 */
function validateShellCommandPathPolicy(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories = false,
): string | null {
  return validateShellCommandPathPolicyWithFence(
    command,
    cwd,
    sandboxRoot,
    extraAllowedDirectories,
    blockReadsOutsideWorkingDirectories,
  );
}

describe("shell-path-policy", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await cleanupTmpDir(root);
    }
  });

  function withRoot<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "lvis-shell-policy-"));
    roots.push(root);
    return fn(root);
  }

  it("allows command operands inside the sandbox after canonicalization", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat ./notes.txt", root, root, [])).toBeNull();
    });
  });

  it("rejects path operands outside the sandbox", () => {
    withRoot((root) => {
      const outside = realpathSync(tmpdir());
      const result = validateShellCommandPathPolicy(`cp ./staged ${outside}/lvis-outside.txt`, root, root, []);
      expect(result).toContain("Sandbox:");
    });
  });

  it("rejects sensitive path operands", () => {
    withRoot((root) => {
      const result = validateShellCommandPathPolicy("cat ~/.ssh/id_rsa", root, root, [tmpdir()]);
      expect(result).toContain("Sensitive path:");
    });
  });

  it("rejects unsupported home expansion before shell execution", () => {
    withRoot((root) => {
      const result = validateShellCommandPathPolicy("cat ~someone/.ssh/id_rsa", root, root, []);
      expect(result).toContain("unsupported user-home expansion");
    });
  });

  it("treats `~\\` as a literal filename on POSIX — the file the file tools open", () => {
    // `expandLeadingTilde` (shared/home-tilde.ts) expands `~\` only where `\`
    // is a separator. This policy used to expand it on every platform, so on
    // POSIX it judged `$HOME/notes.txt` (outside the sandbox) while the tool
    // opened `<cwd>/~\notes.txt` — one ordinary file inside it.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy("cat '~\\notes.txt'", root, root, [])).toBeNull();
      });
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("validates shell working directory through the same sandbox path gate", () => {
    withRoot((root) => {
      expect(validateShellWorkingDirectory(root, root, [])).toBeNull();
      expect(validateShellWorkingDirectory(tmpdir(), root, [])).toContain("Sandbox:");
    });
  });

  /**
   * The traversal rule is now about the EFFECT of the walk, not about walking.
   *
   * An unbounded walk that copies, archives or deletes per hit reaches files no
   * operand names, and that is what the rule exists to refuse. A walk that only
   * prints paths reaches nothing the host does not already let a read reach, so
   * refusing `find / -name x` and `grep -r p /usr` was refusing exactly the
   * reads the shipped policy admits. Both halves are pinned here.
   */
  it("rejects a recursive traversal that MUTATES what it finds", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("find . -name x -delete", root, root, [])).toContain("recursive");
      expect(validateShellCommandPathPolicy("find . -name x -exec rm {} ;", root, root, [])).toContain("recursive");
      expect(validateShellCommandPathPolicy("cp -r ./src ./dst", root, root, [])).toContain("recursive");
      expect(validateShellCommandPathPolicy("tar -cf ./a.tar ./src", root, root, [])).toContain("recursive");
    });
  });

  it("admits a read-only recursive traversal, including one rooted at `/`", () => {
    withRoot((root) => {
      for (const command of [
        "find . -type f",
        "find / -name x",
        "grep -r needle ./src",
        "grep -r foo /usr",
        "ls -laR ./src",
        "rg needle /usr",
        "ls /",
      ]) {
        expect(validateShellCommandPathPolicy(command, root, root, [])).toBeNull();
      }
    });
  });

  it("refuses the read-only traversals again once reads are re-fenced", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("find . -type f", root, root, [], true)).toContain("recursive");
      expect(validateShellCommandPathPolicy("grep -r needle ./src", root, root, [], true)).toContain("recursive");
      expect(validateShellCommandPathPolicy("ls -laR ./src", root, root, [], true)).toContain("recursive");
    });
  });

  // The four message cases below run with reads re-fenced: that is now the only
  // configuration in which a read-only traversal is refused at all, and the
  // message is what the refusal says, not when it fires.
  it("`find` block message points at glob_files / list_files and tells the caller to keep the original target path", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("find /tmp/foo -type f", root, root, ["/tmp/foo"], true);
      expect(msg).toContain("find");
      expect(msg).toContain("glob_files");
      expect(msg).toContain("list_files");
      // The "preserve original target path" instruction is the load-bearing fix
      // — stops the LLM from narrowing into a guessed sub-path on retry.
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("`rg` block message points at grep_files and preserves the path", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("rg pattern /tmp/foo", root, root, ["/tmp/foo"], true);
      expect(msg).toContain("grep_files");
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("flag-based `grep -r` block message includes the LVIS alternative + preserve-path hint", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("grep -r needle ./src", root, root, [], true);
      expect(msg).toContain("grep_files");
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("recursive commands without a mapped LVIS alternative still get the preserve-path fallback hint", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("ls -R ./src", root, root, [], true);
      // `ls` has no mapped LVIS alternative (only the explicit flag-set is blocked),
      // so the fallback guidance must still nudge the caller to keep the target path.
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("rejects PowerShell Join-Path dynamic path composition", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("Join-Path $HOME .ssh", root, root, [])).toContain("dynamic path");
    });
  });

  it("rejects .NET path combine expressions", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("[IO.Path]::Combine($HOME, '.ssh')", root, root, [])).toContain("dynamic path");
    });
  });

  it("rejects unresolved shell variables in path operands", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat $PROJECT_SECRET/file.txt", root, root, [])).toContain("unresolved shell variable");
    });
  });

  describe("loop variables whose values the command spells out", () => {
    it("judges each value instead of refusing to judge the operand", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for f in notes.txt draft.txt; do cat $f; done",
            root,
            root,
            [],
          ),
        ).toBeNull();
      });
    });

    it("accepts the brace form and a value used as a path segment", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for name in alpha beta; do cat ./src/${name}/main.c; done",
            root,
            root,
            [],
          ),
        ).toBeNull();
      });
    });

    // The point of reading the values is that they get checked. A list that
    // walks out of the sandbox has to be caught on the value that does it,
    // even when its siblings are fine.
    it("blocks when one value escapes the sandbox", () => {
      withRoot((root) => {
        const verdict = validateShellCommandPathPolicy(
          "for f in notes.txt ../../etc/passwd; do cat ./$f; done",
          root,
          root,
          [],
        );
        expect(verdict).not.toBeNull();
        expect(verdict).not.toContain("unresolved shell variable");
      });
    });

    it("blocks a write built from a value that leaves the sandbox", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for d in build ../../../etc; do mkdir ./$d; done",
            root,
            root,
            [],
          ),
        ).not.toBeNull();
      });
    });

    // Everything below stays unresolvable, so the operand is still refused —
    // reading a literal list must not become a way to wave through a value the
    // command text does not actually contain.
    it("leaves the variable unbound when a value needs the shell to evaluate it", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy("for f in $(ls); do cat ./$f; done", root, root, []),
        ).toContain("unresolved");
      });
    });

    it("leaves the variable unbound when any single value is not a literal", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for f in notes.txt $OTHER; do cat ./$f; done",
            root,
            root,
            [],
          ),
        ).toContain("unresolved shell variable");
      });
    });

    it("leaves a glob unbound rather than guessing what it matches", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy("for f in *.txt; do cat ./$f; done", root, root, []),
        ).toContain("unresolved shell variable");
      });
    });

    it("does not bind a variable the command never loops over", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for f in notes.txt; do cat ./$other; done",
            root,
            root,
            [],
          ),
        ).toContain("unresolved shell variable");
      });
    });

    // Two headers binding the same name: checking both value sets is the
    // conservative reading, since the operand alone does not say which loop
    // it sits in.
    it("checks both value sets when a name is bound twice", () => {
      withRoot((root) => {
        expect(
          validateShellCommandPathPolicy(
            "for f in a.txt; do cat ./$f; done; for f in ../../etc/passwd; do cat ./$f; done",
            root,
            root,
            [],
          ),
        ).not.toBeNull();
      });
    });
  });

  it("expands $PWD and accepts operands that stay inside the sandbox", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat $PWD/notes.txt", root, root, [])).toBeNull();
    });
  });

  it("expands %CD% and accepts operands that stay inside the sandbox", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("type %CD%/notes.txt", root, root, [])).toBeNull();
    });
  });

  it("rejects bare sensitive filenames even without a path separator", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat .env", root, root, [])).toContain("Sensitive path:");
    });
  });

  it("ignores URL operands instead of treating them as filesystem paths", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("curl https://example.com/a/b", root, root, [])).toBeNull();
    });
  });

  it("ignores /dev/null as a shell null device rather than an approvable path", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("test -e ./missing >/dev/null || echo missing", root, root, [])).toBeNull();
    });
  });

  it("does not treat the shell OR operator as a filesystem root operand", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("false || echo ok", root, root, [])).toBeNull();
    });
  });

  it("allows explicit extra directories but still applies sensitive-path policy", () => {
    withRoot((root) => {
      const outside = realpathSync(tmpdir());
      expect(validateShellCommandPathPolicy(`cat ${outside}/allowed.txt`, root, root, [outside])).toBeNull();
      expect(validateShellCommandPathPolicy(`cat ${outside}/.env`, root, root, [outside])).toContain("Sensitive path:");
    });
  });

  /**
   * Commands taken from a 89-task agentic run in which this policy refused 152
   * calls, and the model spent a median 2.3 rounds rewriting each one. Every
   * command below was REFUSED before the non-path-operand rule, the heredoc
   * redaction and the command-substitution pass, and none of them names a path
   * the policy was ever able to check: the operand is program text, a pattern,
   * an output format, or a heredoc body.
   *
   * The originals are reproduced with hostnames and organisation names replaced
   * by `example.test` / `Example Org`; nothing else about their shape changed.
   */
  const NON_PATH_OPERAND_CORPUS: readonly { label: string; command: string }[] = [
    { label: "R code carrying `$` column access", command: `Rscript -e 'd <- read.csv("data.csv"); print(nrow(d[d$a > 1, ]))'` },
    { label: "python -c one-liner with a division slash", command: `python3 -c "w,h=2400,1800; print((w*h) // 512)"` },
    { label: "perl cluster code option", command: `perl -ne 'chomp; s/\\s//g; print $seq .= $_;' seq.fa` },
    { label: "awk program with a regex and fields", command: `awk '{addr=$1; if (addr ~ /^0000000000400/) print}' disasm.txt` },
    { label: "awk after a `&&` boundary", command: `cd . && awk 'NR<=3{next} { n=split($0, a, " ") }' image.ppm` },
    { label: "sed address range", command: `sed -n '/^class FormDict/,/^class /p' bottle.py` },
    { label: "grep pattern that begins with a slash", command: `grep -vE "^[+-] *$|^[+-][+]" diff.txt` },
    { label: "curl --write-out format", command: `curl -sS -o ./out.json -w "HTTP %{http_code}\\n" https://example.test/api` },
    { label: "openssl subject DN", command: `openssl req -x509 -subj "/O=Example Org/CN=dev.example.test" -out ./cert.pem` },
    // A double-quoted argument that begins with `/` is an option VALUE, not a
    // path. The full certificate-request form was refused twice in a second
    // bench run, both times as a target outside the allowed directories: the
    // subject DN resolved to an absolute path nothing would ever open, while
    // the two operands that ARE paths (`-keyout`, `-out`) were unremarkable.
    {
      label: "openssl subject DN in the full certificate-request form",
      command: `openssl req -x509 -newkey rsa:2048 -nodes -keyout ./key.pem -out ./cert.pem -days 365 -subj "/O=Example Org/CN=svc.example.test"`,
    },
    // The same shape one layer down. The single-quoted entry above reaches the
    // scan as a literal run; double quotes are an expansion-active run and
    // arrive by a different route through the tokenizer, so both are pinned.
    { label: "double-quoted sed address range", command: `sed -n "/def sample/,/return Fit/p" file.py` },
    { label: "echo carrying a substitution", command: `echo "total lines: $(wc -l < ./log.txt)"` },
    { label: "assignment whose value is only a substitution", command: `p=$(command -v cc); echo "$p"` },
    { label: "quoted heredoc body with a division slash", command: "python3 - <<'EOF'\nnstep = int(2.0 / 0.002)\nprint(nstep)\nEOF" },
    { label: "quoted heredoc body with a comment slash", command: "cat > ./t.js <<'EOF'\n// spawn the child\nconst p = 1;\nEOF" },
    { label: "quoted heredoc body naming a traversal verb", command: "python3 - <<'EOF'\n# find a cert that verifies the host\nprint('ok')\nEOF" },
    { label: "identify format string", command: `identify -format "%w %h %b\\n" ./a.jpg` },
    { label: "dpkg-query format string", command: `dpkg-query -W -f '\${Package} \${Version}\\n'` },
  ];

  it.each(NON_PATH_OPERAND_CORPUS)(
    "no longer refuses a non-path operand: $label",
    ({ command }) => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(command, root, root, [])).toBeNull();
      });
    },
  );

  /**
   * The other half of the same corpus: commands that name a real path the
   * policy must keep refusing. If the exemptions above ever widen into these,
   * the containment they were carved out of is gone.
   */
  it("still refuses a genuinely dynamic path operand", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy(`D="/usr/local/bin"; cp ./pmars "$D/pmars"`, root, root, []))
        .toContain("unresolved shell variable");
      expect(validateShellCommandPathPolicy(`A=/etc; B=svc; cat $A/$B/conf.cfg`, root, root, []))
        .toContain("unresolved shell variable");
      // A substitution INSIDE a path operand is still a dynamic path: the
      // exemption is only for a token that stops looking like a path once the
      // substitution is removed.
      expect(validateShellCommandPathPolicy(`curl -s https://example.test/a -o /var/$(basename "$f")`, root, root, []))
        .toContain("unresolved command substitution");
    });
  });

  it("still refuses an out-of-boundary operand carried by an exempted verb", () => {
    withRoot((root) => {
      // echo's ARGUMENTS are data, but its redirect target is not.
      expect(validateShellCommandPathPolicy(`echo pwned > /etc/passwd`, root, root, []))
        .toContain("Sandbox:");
      // The second positional of printf is not the format string.
      expect(validateShellCommandPathPolicy(`printf '%s' /etc/shadow`, root, root, []))
        .toContain("Sensitive path:");
      // awk's PROGRAM is exempt; its input file is not.
      expect(validateShellCommandPathPolicy(`awk '{print $1}' /etc/passwd`, root, root, []))
        .toContain("Sandbox:");
      // `-f` moves awk's program to a FILE, so the first positional is a path again.
      expect(validateShellCommandPathPolicy(`awk -f ./prog.awk /etc/passwd`, root, root, []))
        .toContain("Sandbox:");
    });
  });

  it("still applies the sensitive-path rule through an exempted verb", () => {
    withRoot((root) => {
      const key = join(homedir(), ".ssh", "id_rsa");
      expect(validateShellCommandPathPolicy(`echo pwned > ${key}`, root, root, []))
        .toContain("Sensitive path:");
      expect(validateShellCommandPathPolicy(`awk '{print $1}' ${key}`, root, root, []))
        .toContain("Sensitive path:");
    });
  });

  it("inspects a command substitution body as a command rather than as path text", () => {
    withRoot((root) => {
      // Before the substitution pass this reported an unresolved variable and
      // never judged the path at all.
      const key = join(homedir(), ".ssh", "id_rsa");
      expect(validateShellCommandPathPolicy(`echo "count: $(wc -l < ${key})"`, root, root, []))
        .toContain("Sensitive path:");
      expect(validateShellCommandPathPolicy(`echo "count: \`wc -l < ${key}\`"`, root, root, []))
        .toContain("Sensitive path:");
    });
  });

  /**
   * Each of these is a way the non-path-operand exemptions could have widened
   * what the policy allows. They are the three holes the exemptions were
   * narrowed to close, pinned so a later addition to the table cannot reopen
   * one silently.
   */
  it("treats an operand that IS a substitution as a dynamic path, not as a command", () => {
    withRoot((root) => {
      // The substitution's output is the operand; what it will name is unknown
      // until the shell runs it, so calling it "a command we inspected" would
      // hand `cat` an unchecked path. Two layers refuse these now — the
      // recursive pass reads the substitution as a command and judges the path
      // inside it, and the shape rule refuses the operand for being a
      // substitution at all — so the assertion is on the refusal, not on which
      // of them spoke first.
      expect(validateShellCommandPathPolicy(`cat $(echo /etc/passwd)`, root, root, []))
        .not.toBeNull();
      expect(validateShellCommandPathPolicy("cat `echo /etc/passwd`", root, root, []))
        .not.toBeNull();
      // With a body that names no path, only the shape rule can speak.
      expect(validateShellCommandPathPolicy("cat `whoami`", root, root, []))
        .toContain("unresolved command substitution");
    });
  });

  /**
   * sed's script slot in full. The script is the first positional, or the value
   * of `-e`; `-f` names a script FILE and so stays a path, and once either `-e`
   * or `-f` has supplied the script the first positional is a path again.
   *
   * Pinned as one test because the halves only mean something together: exempt
   * the script without also moving the positional, and `sed -e 's/a/b/' secret`
   * stops being checked.
   */
  it("exempts sed's script slot without exempting the file it edits", () => {
    withRoot((root) => {
      const key = join(homedir(), ".ssh", "id_rsa");
      // Script slots — not paths.
      expect(validateShellCommandPathPolicy(`sed -n "/def sample/,/return Fit/p" file.py`, root, root, []))
        .toBeNull();
      expect(validateShellCommandPathPolicy(`sed -e "/def sample/,/return Fit/p" file.py`, root, root, []))
        .toBeNull();
      // `-f` names a script FILE, so its value is judged like any other path.
      expect(validateShellCommandPathPolicy(`sed -f ${key} file.py`, root, root, []))
        .toContain("Sensitive path:");
      // With the script supplied by an option, the first positional is a path.
      expect(validateShellCommandPathPolicy(`sed -e 's/a/b/' ${key}`, root, root, []))
        .toContain("Sensitive path:");
      expect(validateShellCommandPathPolicy(`sed -f ./prog.sed ${key}`, root, root, []))
        .toContain("Sensitive path:");
      // And the operand after a plain script is still the file being read.
      expect(validateShellCommandPathPolicy(`sed -n '1p' ${key}`, root, root, []))
        .toContain("Sensitive path:");
    });
  });

  it("does not exempt an awk variable, which the program can open as a file", () => {
    withRoot((root) => {
      const key = join(homedir(), ".ssh", "id_rsa");
      expect(validateShellCommandPathPolicy(`awk -v f=${key} 'BEGIN{while((getline l < f)>0) print l}'`, root, root, []))
        .toContain("Sensitive path:");
    });
  });

  it("does not exempt an option value carrying the @-file sigil", () => {
    withRoot((root) => {
      const key = join(homedir(), ".ssh", "id_rsa");
      expect(validateShellCommandPathPolicy(`curl -w @${key} https://example.test/`, root, root, []))
        .toContain("Sensitive path:");
      expect(validateShellCommandPathPolicy(`curl --write-out=@${key} https://example.test/`, root, root, []))
        .toContain("Sensitive path:");
    });
  });

  /**
   * Bypasses found by a differential security review of this change, each
   * asserted on the exact string that got through. All of them were DENY on
   * main and became ALLOW under an earlier revision of the exemptions; the
   * shapes they exploit are the reason the rules below them look the way they
   * do.
   */
  describe("closed bypasses", () => {
    it("does not let a `#`-commented heredoc opener erase the lines after it", () => {
      withRoot((root) => {
        // bash never opens a heredoc here — the `<<'X'` is inside a comment — so
        // line 2 really runs. Treating it as a heredoc deleted line 2 from the
        // scan entirely.
        expect(validateShellCommandPathPolicy("echo hi # <<'X'\ncat /etc/shadow\nX", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("# <<'X'\ncat /etc/shadow\nX", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("echo hi # <<-'X'\ncat /etc/shadow\nX", root, root, []))
          .toContain("Sensitive path:");
      });
    });

    it("still treats a mid-token `#` as text, not as a comment", () => {
      withRoot((root) => {
        // A URL fragment is one argument. If `#` were a comment anywhere, the
        // rest of the command would stop being scanned.
        expect(validateShellCommandPathPolicy("curl http://example.test/x#frag", root, root, []))
          .toBeNull();
        expect(validateShellCommandPathPolicy("cat ./a#b.txt /etc/shadow", root, root, []))
          .toContain("Sensitive path:");
      });
    });

    it("checks the source of an input redirect, which appears in no argv slot", () => {
      withRoot((root) => {
        const key = join(homedir(), ".ssh", "id_rsa");
        expect(validateShellCommandPathPolicy(`tr -d x < ${key}`, root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("echo x < /etc/shadow", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("cat < /etc/shadow", root, root, []))
          .toContain("Sensitive path:");
      });
    });

    it("checks echo and tr arguments, which become the next process's operands", () => {
      withRoot((root) => {
        const key = join(homedir(), ".ssh", "id_rsa");
        // echo opens nothing itself. What it prints is opened one pipe later,
        // and this policy cannot follow a stream to its consumer.
        expect(validateShellCommandPathPolicy("echo /etc/shadow | xargs cat", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy(`echo ${key} | xargs cat`, root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("LC_ALL=C echo /etc/shadow", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("for f in a; do echo /etc/shadow; done", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("tr a b > /etc/passwd", root, root, []))
          .toContain("Sandbox:");
      });
    });

    it("recovers the file operand from a sed script that reads or writes one", () => {
      withRoot((root) => {
        // `r R w W`, `s///w` and `s///e` reach the filesystem from inside what
        // otherwise looks like inert program text.
        expect(validateShellCommandPathPolicy("sed '1r /etc/shadow' notes.txt", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("sed '1R /etc/shadow' notes.txt", root, root, []))
          .toContain("Sensitive path:");
        expect(validateShellCommandPathPolicy("sed -e '/x/W /etc/cron.d/x' notes.txt", root, root, []))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("sed 's/a/b/w /etc/cron.d/x' notes.txt", root, root, []))
          .toContain("Sandbox:");
      });
    });

    it("checks a bare path handed to a code slot, which the command executes", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy("sh -c /etc/evil.sh", root, root, []))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("bash --command=/etc/evil.sh", root, root, []))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("node --eval=/etc/passwd", root, root, []))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("python3 -c=/etc/passwd", root, root, []))
          .toContain("Sandbox:");
      });
    });

    it("checks a bare path handed to a grep pattern slot", () => {
      withRoot((root) => {
        // Re-fenced, because the claim is about the SLOT — that a bare path in
        // the pattern position is still read as an operand — and `grep` is a
        // read verb, so under the shipped policy the operand is seen and then
        // admitted. Fencing reads is what makes "seen" observable here.
        expect(validateShellCommandPathPolicy("grep -- /etc/passwd notes.txt", root, root, [], true))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("grep --regexp=/etc/passwd notes.txt", root, root, [], true))
          .toContain("Sandbox:");
        // A pattern that is not path-shaped keeps its exemption.
        expect(validateShellCommandPathPolicy("grep needle notes.txt", root, root, []))
          .toBeNull();
      });
    });

    /**
     * One negative case per exempted verb, each of the form
     * `<verb> <boolean-flag-or-slot> <path>`.
     *
     * Every exemption that leaked did so because nothing asserted the negative
     * side of it. A shared list of "code options" applied to every interpreter
     * is the specific way that happened: `bash -e` is errexit and `python3 -E`
     * ignores the environment, so the operand after them was swallowed as if it
     * were program text.
     */
    const BOOLEAN_FLAG_BYPASSES: readonly { label: string; command: string }[] = [
      { label: "bash -e is errexit", command: "bash -e /etc/evil.sh" },
      { label: "sh -e is errexit", command: "sh -e /etc/evil.sh" },
      { label: "zsh -e is errexit", command: "zsh -e /etc/evil.sh" },
      { label: "dash -e is errexit", command: "dash -e /etc/evil.sh" },
      { label: "ksh -e is errexit", command: "ksh -e /etc/evil.sh" },
      { label: "bash -E inherits traps", command: "bash -E /etc/evil.sh" },
      { label: "python3 -E ignores the environment", command: "python3 -E /etc/evil.py" },
      { label: "php -e is extended info", command: "php -e /etc/passwd" },
      { label: "deno -c names a config file", command: "deno -c /etc/deno.json run x" },
      { label: "node -c is a syntax check", command: "node -c /etc/evil.js" },
    ];

    it.each(BOOLEAN_FLAG_BYPASSES)(
      "does not swallow the path after a boolean flag: $label",
      ({ command }) => {
        withRoot((root) => {
          expect(validateShellCommandPathPolicy(command, root, root, [])).not.toBeNull();
        });
      },
    );

    it("still exempts each verb's real code option", () => {
      withRoot((root) => {
        // The other half of the table above: narrowing the option sets must not
        // start refusing the programs they exist for.
        for (const command of [
          `bash -c "echo hi; ls ./x"`,
          `python3 -c "w,h=2400,1800; print((w*h) // 512)"`,
          `node -e "console.log(1/2)"`,
          `php -r 'echo 1/2;'`,
          `Rscript -e 'd <- read.csv("data.csv"); print(nrow(d))'`,
          `perl -ne 'chomp; s/\\s//g; print $seq .= $_;' seq.fa`,
        ]) {
          expect(validateShellCommandPathPolicy(command, root, root, [])).toBeNull();
        }
      });
    });

    it("reads a shell -c payload as a command instead of exempting it", () => {
      withRoot((root) => {
        // The payload is a command line this policy can parse, so the operand
        // inside it is judged rather than hidden behind "that slot holds code".
        // A WRITE inside the payload is refused under the shipped policy…
        expect(validateShellCommandPathPolicy("sh -c 'echo hi > /etc/x'", root, root, []))
          .toContain("Sandbox:");
        // …a Layer 0 path inside it is refused whatever the effect…
        expect(validateShellCommandPathPolicy(`bash -c "cat /etc/shadow"`, root, root, []))
          .toContain("Sensitive path:");
        // …and a read inside it is admitted, the same as the bare command.
        expect(validateShellCommandPathPolicy("sh -c 'cat /etc/hosts'", root, root, []))
          .toBeNull();
        // Re-fenced, the read operand inside the payload is refused, which is
        // what shows the payload was parsed rather than exempted as code.
        expect(validateShellCommandPathPolicy("sh -c 'cat /etc/passwd'", root, root, [], true))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy("sh -c 'cat ./notes.txt'", root, root, []))
          .toBeNull();
      });
    });

    /**
     * Negative cases for every remaining exempted slot, so a later widening of
     * one of these tables fails a test rather than a review.
     */
    it("keeps the file operand checked beside every exempted slot", () => {
      withRoot((root) => {
        const outside = "/etc/shadow";
        for (const command of [
          `tr a b < ${outside}`,
          `grep -e needle ${outside}`,
          `grep --include=*.ts needle ${outside}`,
          `rg -g '*.ts' needle ${outside}`,
          `sed -e 's/a/b/' ${outside}`,
          `awk -F: '{print $1}' ${outside}`,
          `stat -c '%s' ${outside}`,
          `dpkg-query -W -f '\${Package}' ${outside}`,
          `identify -format "%w" ${outside}`,
          `openssl req -subj "/O=Example Org/CN=x" -out ${outside}`,
          `curl -w "%{http_code}" -o ${outside} https://example.test/`,
          `printf '%s' ${outside}`,
        ]) {
          expect(validateShellCommandPathPolicy(command, root, root, []))
            .not.toBeNull();
        }
      });
    });

    it("finds the verb behind a shell keyword and behind a background `&`", () => {
      withRoot((root) => {
        // `do cd "$f"` — a verb scan that stops at the keyword never sees the
        // `cd`, so the dynamic-destination guard did not run and every later
        // relative operand was resolved against a directory already left.
        expect(validateShellCommandPathPolicy(`for f in a; do cd "$f"; cat notes.txt; done`, root, root, []))
          .toContain("cannot be resolved before running");
        // A background `&` ends a command just as `&&` does.
        expect(validateShellCommandPathPolicy("ls & find . -name x", root, root, [], true))
          .toContain("recursive shell filesystem traversal");
        expect(validateShellCommandPathPolicy("ls & cp -r ./a ./b", root, root, []))
          .toContain("recursive shell filesystem traversal");
        // …but an fd redirect that merely spells `&` is not a boundary.
        expect(validateShellCommandPathPolicy("ls ./x 2>&1", root, root, [])).toBeNull();
        expect(validateShellCommandPathPolicy("ls ./x &> ./log", root, root, [])).toBeNull();
      });
    });

    it("reads a shell -c payload in every form the option can wear", () => {
      withRoot((root) => {
        // Matching `-c` as an exact token saw only the spaced form. The other
        // three run the same payload: `-lc` clusters the flag with `-l`, and an
        // attached value arrives as one word because the tokenizer has already
        // removed the quotes by then.
        // Re-fenced: the payload carries a READ, so the refusal that proves the
        // form was parsed only exists once reads are confined again.
        for (const command of [
          "sh -c 'cat /etc/passwd'",
          "bash -lc 'cat /etc/passwd'",
          "sh -c'cat /etc/passwd'",
          `sh -c"cat /etc/passwd"`,
          "for f in a; do sh -c 'cat /etc/passwd'; done",
        ]) {
          expect(validateShellCommandPathPolicy(command, root, root, [], true))
            .toContain("Sandbox:");
        }
        // A payload that stays inside the boundary still passes.
        expect(validateShellCommandPathPolicy("bash -lc 'cat ./notes.txt'", root, root, []))
          .toBeNull();
      });
    });

    it("does not treat a here-string operand as a file it reads", () => {
      withRoot((root) => {
        // `<<<` places a literal word on stdin. Reading it as a filename made
        // the string itself an operand — and `grep x <<< '/etc/shadow'` would
        // then be refused for a file nothing opens.
        expect(validateShellCommandPathPolicy("grep x <<< 'a b'", root, root, []))
          .toBeNull();
        // A plain `<` still names a file, and is still checked.
        expect(validateShellCommandPathPolicy("grep x < /etc/shadow", root, root, []))
          .toContain("Sensitive path:");
      });
    });

    it("keeps echo arguments refused even when they only look like a path", () => {
      withRoot((root) => {
        // The cost of the rule above: echo data carrying a variable nothing can
        // resolve is refused as a dynamic path. Exempting echo bought one shape
        // and cost the whole pipe class, so echo is judged like any other verb.
        expect(validateShellCommandPathPolicy(`echo "=== $d/log ==="`, root, root, []))
          .toContain("unresolved shell variable");
        // What narrows the cost is resolving the value rather than exempting
        // the verb: the same argument under a loop that spells out its values
        // is judged on those values, and passes because they stay inside.
        expect(validateShellCommandPathPolicy(`for d in a b; do echo "=== $d/log ==="; done`, root, root, []))
          .toBeNull();
        // And it is a judgement, not a pass: a value that leaves the boundary
        // is caught in exactly the same argument.
        expect(validateShellCommandPathPolicy(`for d in a ../../etc; do echo "=== $d/log ==="; done`, root, root, []))
          .not.toBeNull();
      });
    });
  });


  /**
   * The read/write asymmetry, one row per command shape, asserted in BOTH
   * setting states.
   *
   * Reading it as a table is the point: the same file (`/etc/x`) is admitted or
   * refused depending only on what the leaf carrying it does, and the second
   * column shows that `blockReadsOutsideWorkingDirectories` restores the
   * symmetric boundary the host had before.
   */
  describe("read/write asymmetry — differential table", () => {
    /** `null` = admitted; a string = the fragment the refusal must contain. */
    type Verdict = string | null;
    const ROWS: readonly { label: string; command: string; wide: Verdict; fenced: Verdict }[] = [
      // ── Reads: wide by default, confined once re-fenced ────────────
      { label: "ls /", command: "ls /", wide: null, fenced: "Sandbox:" },
      { label: "find / -name x", command: "find / -name x", wide: null, fenced: "recursive" },
      { label: "grep -r foo /usr", command: "grep -r foo /usr", wide: null, fenced: "recursive" },
      { label: "cat /etc/hosts", command: "cat /etc/hosts", wide: null, fenced: "Sandbox:" },
      { label: "stat /etc/hosts", command: "stat /etc/hosts", wide: null, fenced: "Sandbox:" },
      { label: "du /usr", command: "du /usr", wide: null, fenced: "Sandbox:" },
      { label: "head /etc/hosts", command: "head /etc/hosts", wide: null, fenced: "Sandbox:" },
      { label: "wc -l /etc/hosts", command: "wc -l /etc/hosts", wide: null, fenced: "Sandbox:" },
      // A nested command line is re-entered and judged, so its payload gets the
      // same answer the bare command would.
      { label: "sh -c reading outside", command: "sh -c 'cat /etc/hosts'", wide: null, fenced: "Sandbox:" },
      // An input redirect source is a read, so a read leaf reaches one outside.
      { label: "input redirect into a read leaf", command: "wc -l < /etc/hosts", wide: null, fenced: "Sandbox:" },
      // …but a WRITE leaf's input source stays confined. The flat scan behind
      // the per-leaf walk attributes a candidate to its whole SEGMENT, and a
      // segment that writes confines every path in it. That is the conservative
      // direction — it can only refuse a command the leaf walk had admitted,
      // never admit one it refused — so it is left as is rather than taught to
      // re-derive per-operand effects the leaf walk already has.
      { label: "input redirect into a write leaf", command: "xargs rm < /etc/list", wide: "/etc/list", fenced: "/etc/list" },

      // ── Layer 0: unchanged by the asymmetry, refused in both states ──
      { label: "cat ~/.ssh/id_rsa", command: "cat ~/.ssh/id_rsa", wide: "Sensitive path:", fenced: "Sensitive path:" },

      // ── Writes and execution: confined in both states ──────────────
      // The redirect TARGET is the write here; `/etc/hosts` on the left is a
      // read and is admitted, which is why the refusal names `/tmp/out`.
      { label: "read piped into an outside write target", command: "cat /etc/hosts > /tmp/out", wide: "/tmp/out", fenced: "/etc/hosts" },
      { label: "tee", command: "tee /etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "dd", command: "dd if=/dev/zero of=/etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "sed -i", command: "sed -i s/a/b/ /etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "sed s///w", command: "sed 's/a/b/w /etc/x' in", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "find -delete", command: "find / -delete", wide: "recursive", fenced: "recursive" },
      { label: "find -exec", command: "find / -exec rm {} ;", wide: "recursive", fenced: "recursive" },
      { label: "sh -c writing outside", command: "sh -c 'echo hi > /etc/x'", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "mkdir", command: "mkdir /etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "chmod", command: "chmod 777 /etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      { label: "cp into outside", command: "cp ./a /etc/x", wide: "Sandbox:", fenced: "Sandbox:" },
      // Every operand of a write verb is confined, the source included: `cp`
      // opens both, and nothing in the argv says which one it will create.
      { label: "cp from outside", command: "cp /etc/hosts /tmp/x", wide: "/etc/hosts", fenced: "/etc/hosts" },

      // ── Compound: judged per leaf, not on whichever verb came first ──
      { label: "read leaf then write leaf", command: "ls /; rm -rf /opt/x", wide: "/opt/x", fenced: "Sandbox:" },
    ];

    it.each(ROWS)("$label — reads wide", ({ command, wide }) => {
      withRoot((root) => {
        const result = validateShellCommandPathPolicy(command, root, root, []);
        if (wide === null) expect(result).toBeNull();
        else expect(result).toContain(wide);
      });
    });

    it.each(ROWS)("$label — reads re-fenced", ({ command, fenced }) => {
      withRoot((root) => {
        const result = validateShellCommandPathPolicy(command, root, root, [], true);
        if (fenced === null) expect(result).toBeNull();
        else expect(result).toContain(fenced);
      });
    });

    it("admits the whole command once the write target's directory is granted", () => {
      withRoot((root) => {
        const grant = realpathSync(mkdtempSync(join(tmpdir(), "lvis-grant-")));
        roots.push(grant);
        // The read half was never the obstacle; granting the directory the
        // WRITE lands in is what clears the command.
        expect(validateShellCommandPathPolicy(`cat /etc/hosts > ${grant}/out`, root, root, [grant]))
          .toBeNull();
      });
    });

    it("refuses a write that reaches outside through a symlink inside a granted directory", () => {
      withRoot((root) => {
        const grant = realpathSync(mkdtempSync(join(tmpdir(), "lvis-grant-")));
        roots.push(grant);
        symlinkSync("/etc", join(grant, "to-etc"));
        // Canonicalization resolves the link before the boundary compare, so
        // the grant covers the directory and not what it points at.
        expect(validateShellCommandPathPolicy(`echo hi > ${grant}/to-etc/x`, root, root, [grant]))
          .toContain("Sandbox:");
        // …and the read through the same link is admitted, which is the whole
        // asymmetry in one pair of assertions.
        expect(validateShellCommandPathPolicy(`cat ${grant}/to-etc/hosts`, root, root, [grant]))
          .toBeNull();
      });
    });

    /**
     * A gap this change does NOT close, recorded so it is not mistaken for one
     * of the admissions above.
     *
     * awk's program is a single quoted token exempted as program text, so the
     * filename inside `print > "/etc/x"` is not an operand any scan here sees —
     * before this change as much as after (the re-fenced column agrees). What
     * contains it is the risk classifier: `awk` is deliberately absent from the
     * read-only verb set, so every awk call escalates to an approval instead of
     * being answered by containment alone.
     */
    it("does not reach a path inside an awk program, in either state", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(`awk '{print > "/etc/x"}' in`, root, root, [])).toBeNull();
        expect(validateShellCommandPathPolicy(`awk '{print > "/etc/x"}' in`, root, root, [], true)).toBeNull();
      });
    });
  });

  it("keeps the cwd-aware leaf walk intact across the new segment boundary", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy(`cd /tmp && cat ../../etc/passwd`, root, root, []))
        .not.toBeNull();
    });
  });

  it("finds a recursive traversal verb that only appears after `&&`", () => {
    withRoot((root) => {
      // `&&` was not a segment boundary, so the head-verb scan saw `mkdir` and
      // stopped; the `cp -r` behind it was never classified.
      expect(validateShellCommandPathPolicy(`mkdir -p ./novnc && cp -r ./share/novnc/. ./novnc/`, root, root, []))
        .toContain("recursive shell filesystem traversal");
      expect(validateShellCommandPathPolicy(`ls -la . && find . -name ".git" -type d`, root, root, [], true))
        .toContain("recursive shell filesystem traversal");
    });
  });

  it("still scans an UNQUOTED heredoc body, where the shell still expands", () => {
    withRoot((root) => {
      // No quotes on the delimiter means `$(…)` in the body really executes, so
      // the body must keep being read as commands.
      const command = "cat <<EOF\n$(cat /etc/passwd)\nEOF";
      expect(validateShellCommandPathPolicy(command, root, root, [])).not.toBeNull();
    });
  });

  it("leaves an unterminated heredoc exactly as it was", () => {
    withRoot((root) => {
      // No terminator line: redaction is a no-op, so the body is still scanned.
      // The body carries a WRITE, so the refusal that proves the body was still
      // scanned does not depend on how reads are fenced.
      const command = "cat <<'EOF'\ncp ./staged /etc/passwd";
      expect(validateShellCommandPathPolicy(command, root, root, [])).toContain("Sandbox:");
    });
  });

  describe("sed file-access operands need no space after the command letter", () => {
    // sed reads the filename from just after the command letter to end of line,
    // so `w/tmp/x` and `w /tmp/x` name the same file. Recovering the operand by
    // splitting the script on whitespace produced the token `w/tmp/x`, which
    // resolves cwd-relative and therefore landed INSIDE the boundary.
    const escapes = [
      ["w, no space", `sed 'w/tmp/outside/x.txt' notes.txt`],
      ["1r, no space", `sed '1r/tmp/outside/x.txt' notes.txt`],
      ["s///w, no space", `sed 's/a/b/w/tmp/outside/x.txt' notes.txt`],
      ["w, spaced", `sed 'w /tmp/outside/x.txt' notes.txt`],
      ["1r, spaced", `sed '1r /tmp/outside/x.txt' notes.txt`],
      ["-e W, no space", `sed -e 'W/tmp/outside/x.txt' notes.txt`],
      ["R, no space", `sed 'R/tmp/outside/x.txt' notes.txt`],
    ] as const;

    for (const [label, command] of escapes) {
      it(`blocks the outside file named by ${label}`, () => {
        withRoot((root) => {
          expect(validateShellCommandPathPolicy(command, root, root, [])).not.toBeNull();
        });
      });
    }

    it("still exempts a sed script that names no file", () => {
      withRoot((root) => {
        // `/^class/` is an address, not a path, and `s|a|b|` uses `|` as its
        // delimiter — neither may be read as a file operand.
        expect(validateShellCommandPathPolicy(`sed -e '/^class/p' -e 's|a|b|' notes.txt`, root, root, []))
          .toBeNull();
      });
    });

    it("does not invent a file operand for `e`, which runs a command", () => {
      withRoot((root) => {
        // `s///e` executes the pattern space; there is no filename after the
        // flag, so nothing may be pushed as a PATH candidate. It is refused for
        // the other reason instead — the text it will run is not knowable here.
        const reason = validateShellCommandPathPolicy(`sed 's/a/b/e' notes.txt`, root, root, []);
        expect(reason).toContain("Dynamic path");
        expect(reason).not.toContain("Sandbox:");
      });
    });
  });

  describe("a shell comment hides nothing behind it", () => {
    // An unbalanced quote inside a comment used to put every character-by-
    // character scanner into a quoted run for the rest of the input, so the
    // command on the next line was never inspected at all.
    const hidden = [
      ["unbalanced single quote", `ls # don't\ncat /etc/shadow`],
      ["unbalanced double quote", `ls # say "hi\ncat /etc/shadow`],
      ["unbalanced backtick", "ls # a `b\ncat /etc/shadow"],
      ["plain comment", `ls # fine\ncat /etc/shadow`],
    ] as const;

    for (const [label, command] of hidden) {
      it(`still reads the command after a comment with an ${label}`, () => {
        withRoot((root) => {
          expect(validateShellCommandPathPolicy(command, root, root, [])).not.toBeNull();
        });
      });
    }

    it("still classifies a traversal verb hidden behind a comment", () => {
      withRoot((root) => {
        // This one goes through splitCommandSegments rather than the leaf scan,
        // which was blinded by the same unbalanced quote.
        expect(validateShellCommandPathPolicy(`ls # don't\nfind . -name x`, root, root, [], true))
          .toContain("recursive shell filesystem traversal");
      });
    });

    it("leaves a `#` inside a word alone", () => {
      withRoot((root) => {
        // `a#b` is a filename, not a comment: bash starts a comment only where a
        // word could start.
        // `/etc/shadow#backup` is not the Layer 0 path `/etc/shadow`, so the
        // only thing that can refuse it is the boundary — and a `cat` operand
        // reaches the boundary only with reads re-fenced.
        expect(validateShellCommandPathPolicy(`cat /etc/shadow#backup`, root, root, [], true))
          .not.toBeNull();
      });
    });

    it("leaves a quoted `#` alone", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(`grep '# /etc/shadow' notes.txt`, root, root, []))
          .toBeNull();
      });
    });
  });

  describe("a sed script that executes", () => {
    it("re-enters the command line `e` runs, instead of exempting it", () => {
      withRoot((root) => {
        // `e COMMAND` runs that line. Reading it as program text left the
        // operand inside completely unexamined, and the whole script token
        // resolved relative to the working directory, so it stayed inside the
        // boundary.
        // Re-fenced for the read payload; the Layer 0 payload below needs no
        // fence, and together they show the line was re-entered as a command.
        expect(validateShellCommandPathPolicy(`sed '1e cat /tmp/outside/x.txt' notes.txt`, root, root, [], true))
          .toContain("Sandbox:");
        expect(validateShellCommandPathPolicy(`sed '1e cat /etc/shadow' notes.txt`, root, root, []))
          .toContain("Sensitive path");
      });
    });

    it("refuses a substitution that executes, because the text is not knowable yet", () => {
      withRoot((root) => {
        // The `e` flag runs the pattern space AFTER substitution, so there is
        // no command line here to inspect.
        for (const command of [
          `sed 's/.*/cat /tmp/outside/x.txt/e' notes.txt`,
          `sed 's/.*/cat \\/etc\\/shadow/e' notes.txt`,
          `sed 's|a|b|e' notes.txt`,
        ]) {
          expect(validateShellCommandPathPolicy(command, root, root, [])).toContain("Dynamic path");
        }
      });
    });

    it("refuses a bare `e`, which runs the pattern space as it stands", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(`sed 'e' notes.txt`, root, root, []))
          .toContain("Dynamic path");
      });
    });

    it("still allows an `e` command that reaches nothing", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(`sed '1e echo hi' notes.txt`, root, root, [])).toBeNull();
      });
    });

    it("still allows a substitution that does not execute", () => {
      withRoot((root) => {
        expect(validateShellCommandPathPolicy(`sed 's/a/b/' notes.txt`, root, root, [])).toBeNull();
        expect(validateShellCommandPathPolicy(`sed -e 's/a/b/g' -e 's/c/d/' notes.txt`, root, root, []))
          .toBeNull();
      });
    });
  });
});
