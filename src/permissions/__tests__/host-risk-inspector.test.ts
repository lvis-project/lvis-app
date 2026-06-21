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
