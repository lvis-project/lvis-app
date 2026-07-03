/**
 * pty-manager unit tests (#1444). Stub ASRT (gate + wrap + cleanup) + the
 * sandbox-capability shell-containment gate + node-pty, and assert the
 * WIRING — they do NOT exercise the real Seatbelt/bwrap PTY allocation (that is
 * the macOS/Linux runtime QA, which the design flags as the primary unknown).
 *
 * Covered:
 *   - FAIL CLOSED: gate off / not-shell-contained → spawn refused, node-pty never
 *     loaded, ASRT never wrapped.
 *   - bad-request: empty tabId.
 *   - happy path (shell-contained): wrapWorkerCommand receives the RESTATED
 *     sensitive denyRead floor + a cwd-derived write jail; pty spawned with the
 *     wrapped argv; onData → ring + emit; input/resize forwarded; onExit emits +
 *     cleans up ASRT state.
 *   - idempotent replay: a second spawn for the same tab replays the ring, does
 *     NOT spawn a second shell.
 *   - kill / killAll tear down + decrement ASRT state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── ASRT mock — gate + wrap controllable per test ──────────
let gateActive = true;
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>(() => Promise.resolve({ argv: ["sandbox-exec", "-p", "prof", "/bin/bash", "-c", "exec /bin/zsh -l -i"], env: {} }));
const cleanupMock = vi.fn(() => Promise.resolve());
vi.mock("../../../permissions/asrt-sandbox.js", () => ({
  isAsrtSandboxActive: () => gateActive,
  wrapWorkerCommand: (command: string, options?: unknown) => wrapWorkerCommandMock(command, options),
  cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.lvis/secrets", "/home/u/.ssh"],
  getDefaultSensitiveWriteDenyPaths: () => [
    "/home/u/.lvis/secrets",
    "/home/u/.ssh",
    "/home/u/.zshrc",
    "/home/u/.config",
    "/home/u/Library/LaunchAgents",
  ],
}));

// ─── shell-containment gate ─────────────────────────────────
let shellContained = true;
vi.mock("../../../permissions/sandbox-capability.js", () => ({
  isActiveSandboxShellContained: () => shellContained,
}));

// ─── write-jail derivation (deterministic) ──────────────────
vi.mock("../../../permissions/sandbox-write-jail.js", () => ({
  deriveSandboxWritePaths: (input: { allowedDirectories: readonly string[] }) => [...input.allowedDirectories],
}));

// ─── env sanitizer (identity-ish) ───────────────────────────
vi.mock("../../../tools/safe-env.js", () => ({
  buildSandboxedChildEnv: (env: NodeJS.ProcessEnv) => ({ ...env, PATH: "/usr/bin" }),
}));

vi.mock("../../../lib/shell-resolver.js", () => ({
  shellQuote: (s: string) => s,
}));

// ─── node-pty mock ──────────────────────────────────────────
type DataCb = (chunk: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 9999;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataCb: DataCb | null = null;
  private exitCb: ExitCb | null = null;
  onData(cb: DataCb) {
    this.dataCb = cb;
    return { dispose: () => { this.dataCb = null; } };
  }
  onExit(cb: ExitCb) {
    this.exitCb = cb;
    return { dispose: () => { this.exitCb = null; } };
  }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.resized.push([c, r]); }
  kill() { this.killed = true; }
  // test helpers
  emitData(chunk: string) { this.dataCb?.(chunk); }
  emitExit(exitCode: number) { this.exitCb?.({ exitCode }); }
}
let lastPty: FakePty | null = null;
const ptySpawnMock = vi.fn<(cmd: string, args: string[], opts: unknown) => FakePty>(() => {
  lastPty = new FakePty();
  return lastPty;
});
vi.mock("node-pty", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => ptySpawnMock(cmd, args, opts),
}));

// Module under test — imported AFTER mocks.
import {
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  setTerminalEmitter,
  __resetTerminalsForTest,
  __terminalSessionCountForTest,
  type TerminalEmit,
} from "../pty-manager.js";
// REAL canonicalizer (NOT mocked) — the module resolves the default terminal cwd
// to `canonicalizePathForMatch(process.cwd())` (the workspace-root anchor) and
// validates a renderer-supplied cwd against it, so the test computes the same.
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";

/** The workspace root the module anchors the write-jail to by default. */
const ROOT = canonicalizePathForMatch(process.cwd());

let emitted: Array<{ event: string; payload: unknown }> = [];
const emit: TerminalEmit = (event, payload) => emitted.push({ event, payload });

beforeEach(() => {
  gateActive = true;
  shellContained = true;
  emitted = [];
  lastPty = null;
  wrapWorkerCommandMock.mockClear();
  cleanupMock.mockClear();
  ptySpawnMock.mockClear();
  __resetTerminalsForTest();
  setTerminalEmitter(emit);
});
afterEach(() => {
  __resetTerminalsForTest();
});

describe("pty-manager fail-closed", () => {
  it("refuses to spawn when the gate is inactive", async () => {
    gateActive = false;
    const res = await spawnTerminal({ tabId: "terminal:1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-shell-contained");
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("refuses to spawn when the sandbox is not shell-contained (e.g. Windows fs+network partial)", async () => {
    shellContained = false;
    const res = await spawnTerminal({ tabId: "terminal:1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-shell-contained");
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("rejects an empty tabId", async () => {
    const res = await spawnTerminal({ tabId: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
  });
});

describe("pty-manager happy path (fs-contained)", () => {
  it("wraps with the restated read+write sensitive floors + a workspace-anchored cwd jail and spawns the wrapped argv", async () => {
    // No cwd supplied (the production renderer path) → default = workspace root.
    const res = await spawnTerminal({ tabId: "terminal:1", cols: 120, rows: 40 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replayed).toBe(false);

    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[]; denyWrite: string[] } },
    ];
    // denyRead floor is RESTATED (per-command denyRead REPLACES the ASRT boot array).
    expect(options.filesystem.denyRead).toContain("/home/u/.lvis/secrets");
    expect(options.filesystem.denyRead).toContain("/home/u/.ssh");
    // denyWrite FLOOR is RESTATED (per-command denyWrite REPLACES the boot array) —
    // shell-rc / ~/.ssh / ~/.config / LaunchAgents persistence vectors are denied.
    expect(options.filesystem.denyWrite).toContain("/home/u/.zshrc");
    expect(options.filesystem.denyWrite).toContain("/home/u/.ssh");
    expect(options.filesystem.denyWrite).toContain("/home/u/.config");
    expect(options.filesystem.denyWrite).toContain("/home/u/Library/LaunchAgents");
    // write jail anchored on the WORKSPACE ROOT — NOT $HOME (cluster-review MAJOR).
    expect(options.filesystem.allowWrite).toContain(ROOT);
    expect(options.filesystem.allowRead).toContain(ROOT);

    // spawned the WRAPPED argv[0] + argv.slice(1).
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string>; cols: number; rows: number }];
    expect(cmd).toBe("sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(opts.cwd).toBe(ROOT);
    expect(opts.cols).toBe(120);
    expect(opts.rows).toBe(40);
    expect(opts.env.TERM).toBe("xterm-256color");
  });

  it("honors a renderer-supplied cwd that is WITHIN the workspace root", async () => {
    const inside = `${ROOT}/proj`;
    const res = await spawnTerminal({ tabId: "terminal:1", cwd: inside });
    expect(res.ok).toBe(true);
    const spawnArgs = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnArgs[2].cwd).toBe(inside);
    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [string, { filesystem: { allowWrite: string[] } }];
    expect(options.filesystem.allowWrite).toContain(inside);
  });

  it("streams pty output to the emitter and buffers it for replay", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    lastPty?.emitData("hello");
    expect(emitted).toContainEqual({ event: "data", payload: { tabId: "terminal:1", chunk: "hello" } });
  });

  it("forwards input + resize to the pty", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    writeTerminal("terminal:1", "ls\n");
    resizeTerminal("terminal:1", 100, 30);
    expect(lastPty?.written).toContain("ls\n");
    expect(lastPty?.resized).toContainEqual([100, 30]);
  });

  it("emits exit + decrements ASRT state when the pty exits", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    lastPty?.emitExit(0);
    expect(emitted.some((e) => e.event === "exit")).toBe(true);
    expect(cleanupMock).toHaveBeenCalled();
    // session dropped after exit.
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("is idempotent per tab: a second spawn replays the ring and does not start a second shell", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    lastPty?.emitData("scrollback");
    emitted = [];
    const res = await spawnTerminal({ tabId: "terminal:1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replayed).toBe(true);
    // no second pty spawn.
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    // ring replayed.
    expect(emitted).toContainEqual({ event: "data", payload: { tabId: "terminal:1", chunk: "scrollback" } });
  });
});

describe("pty-manager lifecycle", () => {
  it("kill tears down the pty + decrements ASRT state", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    killTerminal("terminal:1");
    expect(lastPty?.killed).toBe(true);
    expect(cleanupMock).toHaveBeenCalled();
    expect(__terminalSessionCountForTest()).toBe(0);
  });

  it("killAllTerminals kills every live session", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    await spawnTerminal({ tabId: "terminal:2" });
    expect(__terminalSessionCountForTest()).toBe(2);
    const killed = killAllTerminals();
    expect(killed).toBe(2);
    expect(__terminalSessionCountForTest()).toBe(0);
  });
});

describe("pty-manager cwd validation (write-jail anchor)", () => {
  it("defaults the cwd to the workspace root when none is supplied (never $HOME)", async () => {
    const res = await spawnTerminal({ tabId: "terminal:1" });
    expect(res.ok).toBe(true);
    const spawnArgs = ptySpawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnArgs[2].cwd).toBe(ROOT);
  });

  it("rejects a renderer-supplied cwd OUTSIDE the workspace root (no $HOME write-jail)", async () => {
    const res = await spawnTerminal({ tabId: "terminal:1", cwd: "/etc" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
    // No PTY spawned for a rejected cwd.
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("rejects a relative (non-absolute) cwd", async () => {
    const res = await spawnTerminal({ tabId: "terminal:1", cwd: "relative/path" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-request");
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });
});

describe("pty-manager anti-DoS caps", () => {
  it("refuses to spawn past the concurrent-session cap", async () => {
    const MAX = 16;
    for (let i = 0; i < MAX; i++) {
      const res = await spawnTerminal({ tabId: `terminal:${i}` });
      expect(res.ok).toBe(true);
    }
    expect(__terminalSessionCountForTest()).toBe(MAX);
    const over = await spawnTerminal({ tabId: "terminal:overflow" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("too-many-terminals");
    // No extra PTY spawned past the cap.
    expect(ptySpawnMock).toHaveBeenCalledTimes(MAX);
  });

  it("replaying an EXISTING tab at the cap is still allowed (does not count as new)", async () => {
    const MAX = 16;
    for (let i = 0; i < MAX; i++) await spawnTerminal({ tabId: `terminal:${i}` });
    // Remount of an existing tab replays — must NOT be rejected by the cap.
    const replay = await spawnTerminal({ tabId: "terminal:0" });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
  });

  it("drops an oversized single input write instead of streaming it to the PTY", async () => {
    await spawnTerminal({ tabId: "terminal:1" });
    const huge = "x".repeat(1024 * 1024 + 1); // 1 byte over the cap
    writeTerminal("terminal:1", huge);
    expect(lastPty?.written).not.toContain(huge);
    expect(lastPty?.written.length ?? 0).toBe(0);
    // A normal write still passes.
    writeTerminal("terminal:1", "ls\n");
    expect(lastPty?.written).toContain("ls\n");
  });
});
