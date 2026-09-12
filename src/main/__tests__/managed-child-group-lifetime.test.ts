import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { forceKillManagedChildProcess, getManagedChildProcessCount, spawnManaged } from "../managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

describe.skipIf(process.platform === "win32")("managed child group lifetime", () => {
  it("terminates a same-group worker after root exit and the retention warning", async () => {
    const trackedBefore = getManagedChildProcessCount();
    const node = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
    const child = spawnManaged(node, ["-e", `
      const { spawn } = require("node:child_process");
      const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
      worker.unref();
      process.stdout.write(String(worker.pid));
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] }, { label: "group-lifetime-fixture" });
    let workerOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => { workerOutput += chunk.toString(); });
    const groupId = child.pid;
    let groupGone = false;
    let restoreClock = (): void => {};
    try {
      await once(child, "close");
      expect(child.exitCode).toBe(0);
      expect(Number.isInteger(groupId) && (groupId ?? 0) > 0).toBe(true);
      const workerPid = Number(workerOutput);
      expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
      expect(process.kill(workerPid, 0)).toBe(true);
      expect(process.kill(-groupId!, 0)).toBe(true);
      expect(getManagedChildProcessCount()).toBe(trackedBefore + 1);

      const now = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + TOOL_TIMEOUT_POLICY.processGroupRetentionWarningMs + 1);
      restoreClock = () => clock.mockRestore();
      await delay(TOOL_TIMEOUT_POLICY.processGroupPollMs + 50);
      expect(getManagedChildProcessCount()).toBe(trackedBefore + 1);
      expect(process.kill(workerPid, 0)).toBe(true);

      forceKillManagedChildProcess(child, "later-timeout");
      await vi.waitFor(() => {
        expect(() => process.kill(-groupId!, 0)).toThrow();
        groupGone = true;
        expect(getManagedChildProcessCount()).toBe(trackedBefore);
      }, { timeout: 3_000 });
    } finally {
      restoreClock();
      // The bounded fixture owns this group; never signal it after observing
      // absence, including when the numeric ID could subsequently be reused.
      if (!groupGone && typeof groupId === "number" && groupId > 0) {
        try { process.kill(-groupId, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await vi.waitFor(() => expect(() => process.kill(-groupId, 0)).toThrow(), { timeout: 3_000 });
      }
    }
  });
});
