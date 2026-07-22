/**
 * Session-scoped registry for background shell processes started by the `bash`
 * tool with `run_in_background: true`. Mirrors the module-singleton shape of
 * {@link ../main/managed-child-processes.js} (which this also registers each
 * child with, so background shells are force-killed on app quit).
 *
 * Isolation: every entry is tagged with the `sessionId` that started it, and
 * `bash_output` / `bash_kill` reject a `shellId` that belongs to a different
 * session. Shell ids are unguessable UUIDs, so the session tag is defense in
 * depth on top of an already-unforgeable handle.
 *
 * Output model: stdout and stderr are appended to a single combined buffer in
 * arrival order (a terminal-like transcript), capped at
 * {@link MAX_OUTPUT_CHARS}. Once the cap is reached the buffer stops growing and
 * `truncated` latches true — so the read cursor is never invalidated and
 * incremental reads stay correct.
 */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";

export const MAX_OUTPUT_CHARS = 200_000;
/** Terminal statuses a background shell can settle into. */
export type BackgroundShellStatus = "running" | "exited" | "killed" | "failed";

interface BackgroundShellEntry {
  shellId: string;
  sessionId: string;
  command: string;
  child: ChildProcess;
  status: BackgroundShellStatus;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  readCursor: number;
  startedAt: string;
  stopTracking: () => void;
}

export interface BackgroundShellReadResult {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode: number | null;
  /** New output since the previous read (advances the cursor). */
  output: string;
  /** True once total output hit the cap and later bytes were dropped. */
  truncated: boolean;
  command: string;
}

export interface BackgroundShellManager {
  register(input: {
    sessionId: string;
    command: string;
    child: ChildProcess;
    startedAt: string;
  }): string;
  read(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  kill(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  /** Kill + drop every shell owned by a session (call on session end). */
  disposeSession(sessionId: string): number;
  /** Test-only reset. */
  _resetForTest(): void;
  _size(): number;
}

function createManager(): BackgroundShellManager {
  const shells = new Map<string, BackgroundShellEntry>();

  const append = (entry: BackgroundShellEntry, chunk: string): void => {
    if (entry.outputTruncated) return;
    const remaining = MAX_OUTPUT_CHARS - entry.output.length;
    if (remaining <= 0) {
      entry.outputTruncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      entry.output += chunk;
    } else {
      entry.output += chunk.slice(0, remaining);
      entry.outputTruncated = true;
    }
  };

  const snapshot = (entry: BackgroundShellEntry): BackgroundShellReadResult => {
    const output = entry.output.slice(entry.readCursor);
    entry.readCursor = entry.output.length;
    return {
      shellId: entry.shellId,
      status: entry.status,
      exitCode: entry.exitCode,
      output,
      truncated: entry.outputTruncated,
      command: entry.command,
    };
  };

  const owned = (sessionId: string, shellId: string): BackgroundShellEntry | undefined => {
    const entry = shells.get(shellId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    return entry;
  };

  return {
    register({ sessionId, command, child, startedAt }): string {
      // Keep the registry lean within a long-lived session: drop this session's
      // already-finished shells whose output has been fully read before adding a
      // new one. Never-read terminal shells are preserved (the model may still
      // fetch their final output); everything else is reaped at session end via
      // disposeSession(). This bounds in-session growth without surprising an
      // active poller.
      for (const e of [...shells.values()]) {
        if (
          e.sessionId === sessionId &&
          e.status !== "running" &&
          e.readCursor > 0 &&
          e.readCursor >= e.output.length
        ) {
          e.stopTracking();
          shells.delete(e.shellId);
        }
      }
      const shellId = randomUUID();
      const entry: BackgroundShellEntry = {
        shellId,
        sessionId,
        command,
        child,
        status: "running",
        exitCode: null,
        output: "",
        outputTruncated: false,
        readCursor: 0,
        startedAt,
        stopTracking: trackManagedChildProcess(child, { label: "tool:bash:background" }),
      };
      shells.set(shellId, entry);

      const onStdout = (c: Buffer): void => append(entry, c.toString("utf-8"));
      const onStderr = (c: Buffer): void => append(entry, c.toString("utf-8"));
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("close", (code) => {
        if (entry.status === "running") {
          entry.status = "exited";
          entry.exitCode = code;
        }
      });
      child.on("error", (err) => {
        if (entry.status === "running") {
          entry.status = "failed";
          append(entry, `\n[spawn error] ${err.message}\n`);
        }
      });
      return shellId;
    },

    read(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = owned(sessionId, shellId);
      return entry ? snapshot(entry) : undefined;
    },

    kill(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = owned(sessionId, shellId);
      if (!entry) return undefined;
      if (entry.status === "running") {
        entry.status = "killed";
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      return snapshot(entry);
    },

    disposeSession(sessionId): number {
      let disposed = 0;
      for (const entry of [...shells.values()]) {
        if (entry.sessionId !== sessionId) continue;
        if (entry.status === "running") {
          try {
            entry.child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        entry.stopTracking();
        shells.delete(entry.shellId);
        disposed += 1;
      }
      return disposed;
    },

    _resetForTest(): void {
      for (const entry of [...shells.values()]) {
        entry.stopTracking();
      }
      shells.clear();
    },
    _size(): number {
      return shells.size;
    },
  };
}

/** Process-wide singleton, mirroring managed-child-processes.ts. */
export const backgroundShellManager: BackgroundShellManager = createManager();
