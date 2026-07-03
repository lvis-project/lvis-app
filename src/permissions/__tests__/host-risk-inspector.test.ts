/**
 * Host Risk Inspector unit tests — pins the host-classifies-risk
 * classification contract (project_permission_review_redesign):
 *
 *   (a) DEFAULT-STRICT — anything not confidently read-only is write-equivalent.
 *   (b) Shell commands are parsed host-side: a fully read-only compound → read;
 *       any mutating/unknown leaf → shell. Wrapper commands are stripped.
 *   (c) Filesystem path args that escape allowedDirectories escalate to write;
 *       even contained path args are write (no auto-classify-down).
 *   (d) Network targets (URL-shaped args / host-mediated egress) → network.
 *
 * The inspector reads ONLY host-owned signals — never the declared category.
 */
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectHostRisk, isReadOnlyCommand } from "../reviewer/host-risk-inspector.js";

const TMP = realpathSync(tmpdir());

function signals(overrides: Partial<Parameters<typeof inspectHostRisk>[0]>) {
  return inspectHostRisk({
    source: "plugin",
    finalInput: {},
    pathFields: [],
    allowedDirectories: [],
    ...overrides,
  });
}

describe("inspectHostRisk — shell command classification", () => {
  it("classifies a single read-only command as read", () => {
    expect(signals({ finalInput: { command: "ls -la /tmp" } })).toBe("read");
    expect(signals({ finalInput: { command: "cat file.txt" } })).toBe("read");
    expect(signals({ finalInput: { command: "grep -r foo ." } })).toBe("read");
  });

  it("classifies a mutating command as shell (default-strict)", () => {
    expect(signals({ finalInput: { command: "rm -rf /tmp/x" } })).toBe("shell");
    expect(signals({ finalInput: { command: "mv a b" } })).toBe("shell");
    expect(signals({ finalInput: { command: "npm install" } })).toBe("shell");
  });

  it("classifies an unknown command as shell (never auto-read)", () => {
    expect(signals({ finalInput: { command: "frobnicate --all" } })).toBe("shell");
  });

  it("a compound is read-only only if EVERY leaf is read-only", () => {
    expect(isReadOnlyCommand("ls && cat foo")).toBe(true);
    expect(isReadOnlyCommand("ls | grep foo")).toBe(true);
    expect(isReadOnlyCommand("ls; pwd; whoami")).toBe(true);
    // one mutating leaf taints the whole command
    expect(isReadOnlyCommand("ls && rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("cat foo | tee out")).toBe(false);
  });

  it("treats redirections and command substitution as non-read-only", () => {
    expect(isReadOnlyCommand("echo hi > out")).toBe(false);
    expect(isReadOnlyCommand("cat foo >> log")).toBe(false);
    expect(isReadOnlyCommand("cat < in")).toBe(false);
    expect(isReadOnlyCommand("ls $(rm -rf /)")).toBe(false);
    expect(isReadOnlyCommand("echo `rm -rf /`")).toBe(false);
    // bare parameter expansion does NOT execute — still read-only
    expect(isReadOnlyCommand("ls ${HOME}")).toBe(true);
  });

  it("strips wrapper commands to reach the real verb", () => {
    expect(isReadOnlyCommand("timeout 5s ls")).toBe(true);
    expect(isReadOnlyCommand("nice -n 5 cat foo")).toBe(true);
    expect(isReadOnlyCommand("timeout 5s rm -rf /")).toBe(false);
    // a wrapper used alone is read-only iff the wrapper itself is read-only
    expect(isReadOnlyCommand("env")).toBe(true);
    expect(isReadOnlyCommand("FOO=bar env")).toBe(true);
    expect(isReadOnlyCommand("timeout")).toBe(false);
  });

  it("treats absolute command paths by basename", () => {
    expect(isReadOnlyCommand("/usr/bin/ls -la")).toBe(true);
    expect(isReadOnlyCommand("/bin/rm -rf /")).toBe(false);
  });

  it("classifies read-only git subcommands as read; mutating git as shell", () => {
    expect(signals({ finalInput: { command: "git status" } })).toBe("read");
    expect(signals({ finalInput: { command: "git log --oneline" } })).toBe("read");
    expect(signals({ finalInput: { command: "git commit -m x" } })).toBe("shell");
    expect(signals({ finalInput: { command: "git push" } })).toBe("shell");
  });

  it("escalates a read-only verb carrying a MUTATING FLAG to shell (read-down fix)", () => {
    // These head verbs ARE in the read-only set, but the flag mutates files —
    // the old head-verb-only scan classified them read. Now they escalate.
    expect(signals({ finalInput: { command: "sed -i 's/a/b/' f" } })).toBe("shell");
    expect(signals({ finalInput: { command: "sed --in-place=.bak 's/a/b/' f" } })).toBe("shell");
    expect(signals({ finalInput: { command: "find . -delete" } })).toBe("shell");
    expect(signals({ finalInput: { command: "find . -exec rm {} ;" } })).toBe("shell");
    expect(signals({ finalInput: { command: "awk -i inplace '{print}' f" } })).toBe("shell");
    // Always-mutating verbs (no side-effect-free bare form) → shell.
    expect(signals({ finalInput: { command: "tee out" } })).toBe("shell");
    expect(signals({ finalInput: { command: "dd if=/dev/zero of=f" } })).toBe("shell");
    expect(signals({ finalInput: { command: "truncate -s 0 f" } })).toBe("shell");
  });

  it("does NOT escalate a read-only verb whose benign arg merely resembles a mutating flag", () => {
    // `sed` reading a file literally named to look like a flag value is still a
    // substitution WITHOUT -i → read. Exact-token matching, not substring.
    expect(signals({ finalInput: { command: "sed 's/-i/x/' f" } })).toBe("read");
    // `find` printing (no -delete/-exec) is still read.
    expect(signals({ finalInput: { command: "find . -name x.txt" } })).toBe("read");
  });

  it("is quote-aware — whitespace inside quotes is not a token boundary", () => {
    // `grep "a b" .` must remain read; the naive \\s split would have mangled it
    // but never changed the verb, so this pins the quote-aware behaviour.
    expect(signals({ finalInput: { command: 'grep "a b" .' } })).toBe("read");
    expect(signals({ finalInput: { command: "grep 'a && b' file" } })).toBe("read");
  });

  it("splits compound commands by leaf — a mutating leaf taints the whole", () => {
    expect(signals({ finalInput: { command: "ls && rm -rf /" } })).toBe("shell");
    expect(isReadOnlyCommand("ls && sed -i s/a/b/ f")).toBe(false);
  });

  it("strips a leading assignment before the verb (env X=1 ls → read)", () => {
    expect(signals({ finalInput: { command: "env X=1 ls" } })).toBe("read");
    expect(signals({ finalInput: { command: "FOO=bar ls" } })).toBe("read");
  });

  it("strips a wrapper to reach the verb (timeout 5s cat f → read)", () => {
    expect(signals({ finalInput: { command: "timeout 5s cat f" } })).toBe("read");
  });

  it("fails closed on unbalanced quotes (parse error → shell)", () => {
    expect(signals({ finalInput: { command: "grep 'unterminated" } })).toBe("shell");
  });
});

describe("inspectHostRisk — tighten-only invariant (no shell → read loosening)", () => {
  // Every command that was classified `shell`/non-read-only BEFORE this change
  // must STILL be non-read. This proves the change only tightens (read → shell)
  // and never loosens (shell → read). If any of these flips to read, the
  // security posture regressed.
  const previouslyNonRead: readonly string[] = [
    "rm -rf /tmp/x",
    "mv a b",
    "npm install",
    "frobnicate --all",
    "ls && rm -rf /",
    "cat foo | tee out",
    "echo hi > out",
    "cat foo >> log",
    "cat < in",
    "ls $(rm -rf /)",
    "echo `rm -rf /`",
    "git commit -m x",
    "git push",
    "timeout",
    "timeout 5s rm -rf /",
    "/bin/rm -rf /",
    // The correction proof: command substitution stays non-read (already was).
    "echo $(rm -rf /)",
    // Redirect target stays non-read.
    "cat secret > /etc/passwd",
  ];

  it("keeps every previously-non-read command non-read", () => {
    for (const cmd of previouslyNonRead) {
      expect(isReadOnlyCommand(cmd), `expected non-read: ${cmd}`).toBe(false);
    }
  });

  it("keeps every previously-read command read (no false escalation of the read set)", () => {
    const previouslyRead: readonly string[] = [
      "ls -la /tmp",
      "cat file.txt",
      "grep -r foo .",
      "ls && cat foo",
      "ls | grep foo",
      "ls; pwd; whoami",
      "timeout 5s ls",
      "nice -n 5 cat foo",
      "env",
      "FOO=bar env",
      "/usr/bin/ls -la",
      "git status",
      "git log --oneline",
      "ls ${HOME}",
    ];
    for (const cmd of previouslyRead) {
      expect(isReadOnlyCommand(cmd), `expected read: ${cmd}`).toBe(true);
    }
  });
});

describe("inspectHostRisk — network classification", () => {
  it("classifies a URL-shaped arg as network", () => {
    expect(signals({ finalInput: { url: "https://example.com/api" } })).toBe("network");
    expect(signals({ finalInput: { endpoint: "http://localhost:3000" } })).toBe("network");
  });

  it("classifies a bare host arg as network", () => {
    expect(signals({ finalInput: { host: "graph.microsoft.com" } })).toBe("network");
  });

  it("classifies a URL under an arbitrary key as network (default-strict)", () => {
    expect(signals({ finalInput: { target: "https://example.com/webhook" } })).toBe("network");
    expect(signals({ finalInput: { callback: "wss://example.com/socket" } })).toBe("network");
  });
});

describe("inspectHostRisk — foreign-peer (mcp) source", () => {
  it("classifies any MCP-source tool as network, never classifying down via args", () => {
    // A read-only-looking command from an external MCP server must NOT be
    // downgraded to read — foreign peers are host-owned default-strict network.
    expect(signals({ source: "mcp", finalInput: { command: "ls -la" } })).toBe("network");
    expect(signals({ source: "mcp", finalInput: {} })).toBe("network");
    expect(signals({ source: "mcp", finalInput: { note: "hello" } })).toBe("network");
  });
});

describe("inspectHostRisk — filesystem classification", () => {
  it("escalates a path that escapes allowedDirectories to write", () => {
    expect(
      signals({
        finalInput: { path: "/etc/passwd" },
        pathFields: ["path"],
        allowedDirectories: [TMP],
      }),
    ).toBe("write");
  });

  it("a contained path arg is still write (no auto-classify-down)", () => {
    expect(
      signals({
        finalInput: { path: `${TMP}/workspace/file.txt` },
        pathFields: ["path"],
        allowedDirectories: [TMP],
      }),
    ).toBe("write");
  });
});

describe("inspectHostRisk — default-strict baseline", () => {
  it("returns write when no host-owned signal proves read-only", () => {
    expect(signals({ finalInput: { foo: "bar" } })).toBe("write");
    expect(signals({ finalInput: {} })).toBe("write");
  });

  it("does NOT consult any declared category — only host-owned signals", () => {
    // No command/url/path/host signal present → default-strict write, even
    // though a plugin might have declared this "read".
    expect(signals({ finalInput: { note: "hello" } })).toBe("write");
  });
});
