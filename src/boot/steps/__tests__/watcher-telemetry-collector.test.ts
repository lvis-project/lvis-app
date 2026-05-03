/**
 * Watcher telemetry collector — JSONL appender 회귀 가드.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWatcherTelemetryCollector } from "../watcher-telemetry-collector.js";

describe("watcher-telemetry-collector", () => {
  let workDir: string;
  let logFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "watcher-telem-"));
    logFile = join(workDir, "logs", "watcher-poll.jsonl");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeBus(): {
    subscribe: ReturnType<typeof vi.fn>;
    fire: (data: unknown) => void;
  } {
    let registered: ((data: unknown) => void) | null = null;
    const subscribe = vi.fn((_type: string, handler: (data: unknown) => void) => {
      registered = handler;
      return () => { registered = null; };
    });
    return {
      subscribe,
      fire: (data) => registered?.(data),
    };
  }

  it("정상 payload 가 JSONL 한 줄로 추가된다", async () => {
    const bus = makeBus();
    const collector = startWatcherTelemetryCollector({
      filePath: logFile,
      subscribe: bus.subscribe,
    });

    bus.fire({ state: "initial-seed", ms: 142, msgCount: 100, aborted: false, pluginId: "ms-graph" });
    await collector.awaitFlush();

    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.state).toBe("initial-seed");
    expect(record.ms).toBe(142);
    expect(record.msgCount).toBe(100);
    expect(record.aborted).toBe(false);
    expect(record.plugin).toBe("ms-graph");
    expect(typeof record.ts).toBe("string");
    expect(typeof record.sessionId).toBe("string");
  });

  it("schema 가 깨진 payload 는 silent drop (write 안 함)", async () => {
    const bus = makeBus();
    const collector = startWatcherTelemetryCollector({
      filePath: logFile,
      subscribe: bus.subscribe,
    });

    bus.fire({ /* missing state/ms */ });
    bus.fire(null);
    bus.fire("garbage");
    bus.fire({ state: 123, ms: "abc" });
    await collector.awaitFlush();

    await expect(readFile(logFile, "utf-8")).rejects.toThrow();
  });

  it("같은 부팅 세션의 이벤트는 같은 sessionId 를 가진다", async () => {
    const bus = makeBus();
    const collector = startWatcherTelemetryCollector({
      filePath: logFile,
      subscribe: bus.subscribe,
    });

    bus.fire({ state: "initial-seed", ms: 100, msgCount: 1, aborted: false });
    bus.fire({ state: "incremental", ms: 50, msgCount: 0, aborted: false });
    bus.fire({ state: "catch-up", ms: 200, msgCount: 5, aborted: false });
    await collector.awaitFlush();

    const lines = (await readFile(logFile, "utf-8")).trim().split("\n");
    const sessionIds = lines.map((l) => JSON.parse(l).sessionId);
    expect(new Set(sessionIds).size).toBe(1);
  });

  it("서로 다른 collector 인스턴스는 다른 sessionId 를 가진다", async () => {
    const bus1 = makeBus();
    const bus2 = makeBus();
    const c1 = startWatcherTelemetryCollector({ filePath: logFile, subscribe: bus1.subscribe });
    const c2 = startWatcherTelemetryCollector({ filePath: logFile, subscribe: bus2.subscribe });

    bus1.fire({ state: "incremental", ms: 10, msgCount: 0, aborted: false });
    bus2.fire({ state: "incremental", ms: 20, msgCount: 0, aborted: false });
    await Promise.all([c1.awaitFlush(), c2.awaitFlush()]);

    const lines = (await readFile(logFile, "utf-8")).trim().split("\n");
    const sessionIds = lines.map((l) => JSON.parse(l).sessionId);
    expect(new Set(sessionIds).size).toBe(2);
  });

  it("파일 크기가 MAX_FILE_BYTES 초과 시 .1 으로 rotation", async () => {
    const bus = makeBus();
    // Pre-populate file > 10MB so the first poll triggers rotation.
    await import("node:fs/promises").then((fs) => fs.mkdir(join(workDir, "logs"), { recursive: true }));
    const big = "x".repeat(10 * 1024 * 1024 + 100);
    await writeFile(logFile, big);

    const collector = startWatcherTelemetryCollector({
      filePath: logFile,
      subscribe: bus.subscribe,
    });
    bus.fire({ state: "incremental", ms: 50, msgCount: 0, aborted: false });
    await collector.awaitFlush();

    // 새 파일은 우리 한 줄만, .1 이 큰 백업.
    const content = await readFile(logFile, "utf-8");
    expect(content.trim().split("\n")).toHaveLength(1);
    const backup = await readFile(`${logFile}.1`, "utf-8");
    expect(backup.length).toBeGreaterThan(MAX);
  });

  it("stop() 호출 이후 이벤트는 무시된다", async () => {
    const bus = makeBus();
    const collector = startWatcherTelemetryCollector({
      filePath: logFile,
      subscribe: bus.subscribe,
    });
    bus.fire({ state: "incremental", ms: 50, msgCount: 0, aborted: false });
    await collector.awaitFlush();
    collector.stop();

    bus.fire({ state: "incremental", ms: 99, msgCount: 0, aborted: false });
    await collector.awaitFlush();

    const lines = (await readFile(logFile, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1); // stop 이후 이벤트는 적재 안 됨
  });

  it("writeOne 실패 (예: 권한) 가 plugin 흐름을 throw 시키지 않는다", async () => {
    const bus = makeBus();
    const log = vi.fn();
    const collector = startWatcherTelemetryCollector({
      filePath: "/dev/null/cant-write-here/file.jsonl", // ENOENT 보장
      subscribe: bus.subscribe,
      log,
    });

    expect(() => bus.fire({ state: "incremental", ms: 1, msgCount: 0, aborted: false })).not.toThrow();
    await collector.awaitFlush();
    expect(log).toHaveBeenCalled();
  });
});

const MAX = 10 * 1024 * 1024;
