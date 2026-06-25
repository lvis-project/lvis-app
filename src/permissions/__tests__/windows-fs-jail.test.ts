/**
 * Windows FS-jail shim — unit tests.
 *
 * These pin OUR usage of the (undocumented, version-pinned) `srt-win acl`
 * contract: the exact argv, the stdin `{denyRead,denyWrite}` JSON, and the
 * FAIL-CLOSED behaviour on a non-zero exit / left-stamped path. `srt-win.exe`
 * is a Windows binary, so `child_process`/`fs` are mocked — this is the
 * darwin-testable layer; REAL deny-enforcement is the manual Windows QA gate
 * (lvis-app#1367). If ASRT changes the `acl` CLI, these assertions break first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ─── node:child_process / node:fs mocks ─────────────────────
const spawnSyncMock = vi.fn<
  (cmd: string, args: string[], opts: { input?: string }) => {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }
>();
vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[], opts: { input?: string }) =>
    spawnSyncMock(cmd, args, opts),
}));

const existsSyncMock = vi.fn<(p: string) => boolean>(() => true);
const statSyncMock = vi.fn<(p: string) => { isFile: () => boolean }>(() => ({ isFile: () => true }));
vi.mock("node:fs", () => ({
  existsSync: (p: string) => existsSyncMock(p),
  statSync: (p: string) => statSyncMock(p),
}));

// Force a stable srt-win path so resolution never touches disk.
process.env.SRT_WIN_PATH = "C:\\srt-win.exe";

import {
  injectHolderPid,
  toExplicitFiles,
  stampWindowsFsDeny,
  restoreWindowsFsDeny,
} from "../windows-fs-jail.js";

afterEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  statSyncMock.mockReset();
  statSyncMock.mockReturnValue({ isFile: () => true });
});

describe("injectHolderPid", () => {
  const base = ["C:\\srt-win.exe", "exec", "--name", "g", "--", "cmd.exe", "/c", "echo hi"];

  it("inserts --holder-pid right BEFORE the '--' target separator", () => {
    const out = injectHolderPid(base, 4242);
    const sep = out.indexOf("--");
    expect(out[sep - 2]).toBe("--holder-pid");
    expect(out[sep - 1]).toBe("4242");
    // target side is untouched
    expect(out.slice(sep)).toEqual(["--", "cmd.exe", "/c", "echo hi"]);
  });

  it("is idempotent when --holder-pid is already present", () => {
    const once = injectHolderPid(base, 7);
    expect(injectHolderPid(once, 7)).toEqual(once);
  });

  it("throws (fail-closed) when there is no '--' separator", () => {
    expect(() => injectHolderPid(["srt-win.exe", "exec"], 1)).toThrow(/no '--' target separator/);
  });
});

describe("toExplicitFiles", () => {
  it("keeps regular files and drops dirs/missing (acl rejects dirs/globs)", () => {
    existsSyncMock.mockImplementation((p) => p !== "C:\\missing");
    statSyncMock.mockImplementation((p) => ({ isFile: () => p.endsWith(".key") }));
    const { files, droppedNonFiles } = toExplicitFiles([
      "C:\\secrets\\id.key",
      "C:\\.ssh", // a directory
      "C:\\missing",
    ]);
    expect(files).toEqual(["C:\\secrets\\id.key"]);
    expect(droppedNonFiles).toEqual(["C:\\.ssh", "C:\\missing"]);
  });
});

describe("stampWindowsFsDeny", () => {
  it("invokes `acl stamp --name <g> --holder-pid <pid>` with stdin {denyRead,denyWrite}", () => {
    spawnSyncMock.mockReturnValue({ status: 0, signal: null, stdout: "", stderr: "" });
    stampWindowsFsDeny({ denyRead: ["C:\\a.key"], denyWrite: ["C:\\b"] }, 4242, "my-group");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawnSyncMock.mock.calls[0]!;
    expect(exe).toBe("C:\\srt-win.exe");
    expect(args).toEqual(["acl", "stamp", "--name", "my-group", "--holder-pid", "4242"]);
    expect(JSON.parse(opts.input!)).toEqual({ denyRead: ["C:\\a.key"], denyWrite: ["C:\\b"] });
  });

  it("FAILS CLOSED — throws on a non-zero exit", () => {
    spawnSyncMock.mockReturnValue({ status: 13, signal: null, stdout: "", stderr: "boom" });
    expect(() => stampWindowsFsDeny({ denyRead: [], denyWrite: [] }, 1)).toThrow(/acl stamp failed.*boom/s);
  });
});

describe("restoreWindowsFsDeny", () => {
  it("invokes `acl restore --holder-pid <pid> --json` and passes when all restored", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      stdout: JSON.stringify([{ path: "C:\\a.key", status: "restored" }]),
      stderr: "",
    });
    expect(() => restoreWindowsFsDeny(99, "g")).not.toThrow();
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["acl", "restore", "--name", "g", "--holder-pid", "99", "--json"]);
  });

  it("throws when a path was left stamped (status != restored)", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      stdout: JSON.stringify([
        { path: "C:\\a.key", status: "restored" },
        { path: "C:\\b.key", status: "leftStamped" },
      ]),
      stderr: "",
    });
    expect(() => restoreWindowsFsDeny(99)).toThrow(/left 1 path\(s\) stamped.*b\.key/s);
  });

  it("FAILS CLOSED on unparseable --json output", () => {
    spawnSyncMock.mockReturnValue({ status: 0, signal: null, stdout: "not-json", stderr: "" });
    expect(() => restoreWindowsFsDeny(1)).toThrow(/left 1 path\(s\) stamped.*unparseable/s);
  });
});
