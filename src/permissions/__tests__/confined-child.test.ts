/**
 * The confinement primitive extracted from `worker-spawn.ts`.
 *
 * The worker suite proves the WIRING — that the primitive is called with the
 * right arguments — but it stubs `wrapWorkerCommand`, so a green run there
 * says nothing about what the primitive actually hands ASRT. These assert the
 * command line and filesystem config it composes, which is the part an
 * extraction can silently change.
 *
 * The deny floor is the reason this primitive owns that composition. In ASRT a
 * per-command `denyRead`/`denyWrite` REPLACES the shared boot floor instead of
 * extending it — an empty-but-present array is not nullish — so a caller that
 * omits it hands the child back read of `~/.lvis/secrets`, `~/.ssh`, `~/.aws`.
 * Six call sites restate that floor by hand today. Callers here cannot omit it,
 * and these tests are what keeps that true.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const spawnMock = vi.fn();
const trackMock = vi.fn();
const admissionMock = vi.fn();

vi.mock("../asrt-sandbox.js", () => ({
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.lvis/secrets", "/home/u/.ssh"],
  getDefaultSensitiveWriteDenyPaths: () => ["/home/u/.lvis/secrets", "/home/u/.bashrc"],
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: (label: string) => admissionMock(label),
  trackManagedChildProcess: (child: unknown, opts: unknown) => trackMock(child, opts),
}));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { spawnConfinedChild } = await import("../confined-child.js");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  return child;
}

beforeEach(() => {
  wrapWorkerCommandMock.mockReset();
  wrapWorkerCommandMock.mockResolvedValue({ argv: ["/bin/sandbox", "--", "sh", "-c", "x"], env: {} });
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  trackMock.mockReset();
  admissionMock.mockReset();
});

/** The filesystem config the primitive handed ASRT on the last wrap. */
function lastFilesystem() {
  const [, options] = wrapWorkerCommandMock.mock.calls.at(-1)!;
  return (options as { filesystem: Record<string, string[]> }).filesystem;
}

describe("spawnConfinedChild", () => {
  it("restates the deny floor even when the caller passes no paths at all", async () => {
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
    });

    expect(lastFilesystem().denyRead).toContain("/home/u/.lvis/secrets");
    expect(lastFilesystem().denyWrite).toContain("/home/u/.bashrc");
  });

  it("carries the caller's allow paths alongside the floor, not instead of it", async () => {
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      allowRead: ["/data/in"],
      allowWrite: ["/data/out"],
      baseEnv: {},
    });

    const fs = lastFilesystem();
    expect(fs.allowRead).toEqual(["/data/in"]);
    expect(fs.allowWrite).toEqual(["/data/out"]);
    expect(fs.denyRead).toContain("/home/u/.ssh");
  });

  it("omits allow paths under deny-only, where ACLs grant reachability instead", async () => {
    // Passing them here would imply a confinement the wrap does not perform:
    // on Windows the grant is held against a separate holder process.
    await spawnConfinedChild({
      command: "python.exe",
      args: [],
      label: "worker:x:main:asrt-win",
      grantMode: "deny-only",
      allowRead: ["/data/in"],
      allowWrite: ["/data/out"],
      baseEnv: {},
    });

    const fs = lastFilesystem();
    expect(fs.allowRead).toBeUndefined();
    expect(fs.allowWrite).toBeUndefined();
    expect(fs.denyRead).toContain("/home/u/.lvis/secrets");
  });

  it("quotes every token so a path with spaces cannot mis-split", async () => {
    // ASRT runs this through a shell, so an unquoted path becomes two arguments
    // and the child either fails or opens something else.
    await spawnConfinedChild({
      command: "/opt/my tools/python3",
      args: ["--root", "/data/my folder", "--flag"],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
    });

    const [cmdline] = wrapWorkerCommandMock.mock.calls.at(-1)!;
    expect(cmdline).toContain("'/opt/my tools/python3'");
    expect(cmdline).toContain("'/data/my folder'");
  });

  it("reports the wrap BEFORE spawning, so the caller can undo ASRT state", async () => {
    // The wrap increments ASRT per-command state. A spawn failure after it must
    // still decrement, and only the caller knows how its cleanup is arranged.
    const order: string[] = [];
    spawnMock.mockImplementation(() => {
      order.push("spawn");
      return fakeChild();
    });

    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
      onWrapped: () => order.push("onWrapped"),
    });

    expect(order).toEqual(["onWrapped", "spawn"]);
  });

  it("checks validity on both sides of the wrap", async () => {
    // Windows holder liveness: the ACL grant is only real while the holder is
    // alive, so a holder that dies mid-wrap must not yield a child believed to
    // be confined by a grant that no longer exists.
    const assertStillValid = vi.fn();
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
      assertStillValid,
    });
    expect(assertStillValid).toHaveBeenCalledTimes(2);
  });

  it("does not spawn when validity fails after the wrap", async () => {
    const assertStillValid = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("holder died");
      });

    await expect(
      spawnConfinedChild({
        command: "/usr/bin/python3",
        args: [],
        label: "worker:x:main",
        grantMode: "allow-list",
        baseEnv: {},
        assertStillValid,
      }),
    ).rejects.toThrow("holder died");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses an empty argv rather than spawning something arbitrary", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: [], env: {} });
    await expect(
      spawnConfinedChild({
        command: "/usr/bin/python3",
        args: [],
        label: "worker:x:main",
        grantMode: "allow-list",
        baseEnv: {},
      }),
    ).rejects.toThrow(/empty argv/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns the wrapped argv, never the caller's command", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/usr/bin/sandbox-exec", "-p", "(profile)", "/bin/sh", "-c", "python3"],
      env: {},
    });
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: ["-u"],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
    });

    const [executable, args, options] = spawnMock.mock.calls.at(-1)!;
    expect(executable).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual(["-p", "(profile)", "/bin/sh", "-c", "python3"]);
    expect((options as { shell: boolean }).shell).toBe(false);
  });

  it("lets the sandbox HOME win over the base environment", async () => {
    // The sandbox process home is the last overlay on purpose: a stale HOME
    // inherited from the host would send the child's writes outside its jail.
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: { HOME: "/home/u", KEEP: "1" },
      extraEnv: { HOME: "/sandbox/home" },
    });

    const [, , options] = spawnMock.mock.calls.at(-1)!;
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOME).toBe("/sandbox/home");
    expect(env.KEEP).toBe("1");
  });

  it("registers the child under the caller's label", async () => {
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:meeting:main:asrt",
      grantMode: "allow-list",
      baseEnv: {},
    });
    expect(admissionMock).toHaveBeenCalledWith("worker:meeting:main:asrt");
    expect(trackMock).toHaveBeenCalledWith(expect.anything(), { label: "worker:meeting:main:asrt" });
  });
});
