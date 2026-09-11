import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getManagedChildProcessCount } from "../../main/managed-child-processes.js";
import type { ToolExecutionResult } from "../base.js";

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: vi.fn(async (command: string) => ({
    argv: ["/bin/bash", "-c", command],
    env: { ...process.env },
  })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [],
  getDefaultSensitiveWriteDenyPaths: () => [],
}));

import { BashTool, spawnWithSandbox } from "../shell-tools.js";
import { cleanupAsrtSandboxAfterCommand } from "../../permissions/asrt-sandbox.js";

describe.skipIf(process.platform === "win32")("foreground shell deadline settlement", () => {
  it.each([
    ["plain", "timeout"],
    ["plain", "cancel"],
    ["sandbox", "timeout"],
    ["sandbox", "cancel"],
    ["plain", "complete"],
    ["sandbox", "complete"],
  ] as const)("settles %s %s after the root exits with a detached pipe holder", async (route, stop) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lvis-shell-deadline-")));
    const controller = new AbortController();
    const exitedPids = new Set<number>();
    const trackedBefore = getManagedChildProcessCount();
    const cleanupCalls = vi.mocked(cleanupAsrtSandboxAfterCommand).mock.calls.length;
    // The fixture alone owns these PIDs. The detached holder has a bounded
    // lifetime even if the test's explicit cleanup is interrupted.
    writeFileSync(join(dir, "child.cjs"), `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const holder = process.argv[2] === "holder";
      writeFileSync(holder ? "holder.pid" : "root.pid", String(process.pid));
      if (holder) {
        setTimeout(() => {
          process.stdout.write("late stdout\\n");
          process.stderr.write("late stderr\\n");
        }, ${stop === "complete" ? 500 : 8_000});
      } else {
        writeFileSync("profile.path", process.env.HOME);
        process.stdout.write("root stdout\\n");
        process.stderr.write("root stderr\\n");
        spawn(process.execPath, [__filename, "holder"], {
          detached: true, stdio: ["ignore", "inherit", "inherit"],
        }).unref();
      }
    `);
    const timeoutSeconds = stop === "timeout" ? 1 : 60;
    const pending = route === "plain"
      ? new BashTool().execute({ command: "node child.cjs", timeoutSeconds }, {
        cwd: dir, extraAllowedDirectories: [], metadata: {}, abortSignal: controller.signal,
      })
      : spawnWithSandbox("node child.cjs", dir, [dir], timeoutSeconds, controller.signal);
    let result: ToolExecutionResult | undefined;
    void pending.then((value) => { result = value; });
    try {
      await vi.waitFor(() => {
        expect(existsSync(join(dir, "holder.pid"))).toBe(true);
        const rootPid = Number(readFileSync(join(dir, "root.pid"), "utf8"));
        expect(() => process.kill(rootPid, 0)).toThrow();
        exitedPids.add(rootPid);
      });
      const holderPid = Number(readFileSync(join(dir, "holder.pid"), "utf8"));
      expect(process.kill(holderPid, 0)).toBe(true);
      expect(result).toBeUndefined();
      if (stop === "cancel") controller.abort();
      await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 2_000 });
      expect(result?.output).toContain("root stdout");
      expect(result?.output).toContain("root stderr");
      expect(getManagedChildProcessCount()).toBe(trackedBefore);
      if (stop === "complete") {
        expect(result?.isError).toBe(false);
        expect(result?.metadata?.returncode).toBe(0);
        expect(result?.output).toContain("late stdout");
        expect(result?.output).toContain("late stderr");
        await vi.waitFor(() => expect(() => process.kill(holderPid, 0)).toThrow());
        exitedPids.add(holderPid);
      } else {
        expect(result?.isError).toBe(true);
        expect(result?.metadata?.[stop === "timeout" ? "timedOut" : "aborted"]).toBe(true);
        // Releasing inherited pipes must not broaden the owned process group.
        expect(process.kill(holderPid, 0)).toBe(true);
      }
      if (route === "sandbox") {
        const profile = readFileSync(join(dir, "profile.path"), "utf8");
        expect(existsSync(profile)).toBe(false);
        expect(vi.mocked(cleanupAsrtSandboxAfterCommand).mock.calls.length).toBe(cleanupCalls + 1);
      }
    } finally {
      controller.abort();
      for (const name of ["root", "holder"]) {
        const pidFile = join(dir, `${name}.pid`);
        if (!existsSync(pidFile)) continue;
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid fixture PID");
        if (exitedPids.has(pid)) continue;
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      }
      await pending;
      await cleanupTmpDir(dir);
    }
  });
});
