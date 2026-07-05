




import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

type EventHandlerUnsubscribe = () => void;

export interface WatcherTelemetryCollectorOptions {
  /** Absolute path to the JSONL file (e.g. ~/.lvis/logs/watcher-poll.jsonl) */
  filePath: string;



  subscribe: (
    type: string,
    handler: (data: unknown) => void,
  ) => EventHandlerUnsubscribe;

  log?: (msg: string, meta?: unknown) => void;
}

export interface WatcherTelemetryCollector {
  stop(): void;

  awaitFlush(): Promise<void>;
}

interface PollCompletedPayload {
  state?: string;
  ms?: number;
  msgCount?: number;
  aborted?: boolean;
  pluginId?: string;
}

export function startWatcherTelemetryCollector(
  opts: WatcherTelemetryCollectorOptions,
): WatcherTelemetryCollector {
  const { filePath, subscribe, log } = opts;
  const sessionId = randomUUID();


  let writeChain: Promise<void> = Promise.resolve();

  const enqueue = (record: Record<string, unknown>): void => {
    writeChain = writeChain
      .then(() => writeOne(filePath, record))
      .catch((err) => {
        log?.("[watcher-telemetry] write failed", String(err instanceof Error ? err.message : err));
      });
  };

  const handler = (data: unknown): void => {
    const payload = (data ?? {}) as PollCompletedPayload;
    if (typeof payload.state !== "string" || typeof payload.ms !== "number") {

      return;
    }
    enqueue({
      ts: new Date().toISOString(),
      plugin: payload.pluginId ?? "?",
      sessionId,
      state: payload.state,
      ms: payload.ms,
      msgCount: typeof payload.msgCount === "number" ? payload.msgCount : 0,
      aborted: Boolean(payload.aborted),
    });
  };

  const unsubscribe = subscribe("email.watcher.poll.completed", handler);

  return {
    stop: () => unsubscribe(),
    awaitFlush: () => writeChain,
  };
}

async function writeOne(filePath: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await maybeRotate(filePath);
  await appendFile(filePath, JSON.stringify(record) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function maybeRotate(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {

    return;
  }
  if (size < MAX_FILE_BYTES) return;

  await rename(filePath, `${filePath}.1`).catch(() => {});
}
