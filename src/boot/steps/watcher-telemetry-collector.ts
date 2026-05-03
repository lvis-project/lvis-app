/**
 * Watcher telemetry collector — JSONL appender for `email.watcher.poll.completed`.
 *
 * 플러그인 (ms-graph v0.1.27+) 이 발행하는 poll 단위 텔레메트리 이벤트를 호스트
 * 가 시계열로 적재하기 위한 *최소* consumer. 정식 metrics pipeline (Sentry /
 * OTel / 사내 시계열 DB) 이 들어오기 전 단계 — 운영 중인 사용자 머신의 raw
 * 데이터를 디스크에 모아 로컬에서 `jq` 분석 가능하게.
 *
 * Storage: 사용자 ~/.lvis/logs/watcher-poll.jsonl (한 줄당 한 이벤트, JSON).
 *
 * Rotation: 파일이 MAX_FILE_BYTES 초과 시 `.1` 로 rename 후 새로 시작.
 * 누적 디스크 점유 상한 ~= MAX_FILE_BYTES * 2 (현재 활성 + .1 백업).
 *
 * Schema:
 *   { ts, plugin, state, ms, msgCount, aborted, sessionId? }
 *
 * `sessionId` 는 호스트 부팅 시 1회 생성되는 random UUID 로, 같은 부팅 세션의
 * 이벤트들을 사후 grouping 가능. cross-session distribution 을 분석할 때 같은
 * cold-seed 가 한 세션 안에서 여러 번 발생했는지 같은 boundary 식별.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

type EventHandlerUnsubscribe = () => void;

export interface WatcherTelemetryCollectorOptions {
  /** Absolute path to the JSONL file (e.g. ~/.lvis/logs/watcher-poll.jsonl) */
  filePath: string;
  /**
   * 이벤트 구독 등록 — production 에서는 `boot/types.ts` 의 `onEvent`,
   * 테스트에서는 stub. 함수 분리로 호스트 event bus 에 의존하지 않게.
   */
  subscribe: (
    type: string,
    handler: (data: unknown) => void,
  ) => EventHandlerUnsubscribe;
  /** 비-치명적 에러 (디스크 full, 권한) 로그용. */
  log?: (msg: string, meta?: unknown) => void;
}

export interface WatcherTelemetryCollector {
  stop(): void;
  /** 테스트에서 동기적 flush 가 필요할 때. */
  awaitFlush(): Promise<void>;
}

interface PollCompletedPayload {
  state?: string;
  ms?: number;
  msgCount?: number;
  aborted?: boolean;
  pluginId?: string; // 호스트가 붙여주는 origin 태그 (plugin-runtime.ts)
}

export function startWatcherTelemetryCollector(
  opts: WatcherTelemetryCollectorOptions,
): WatcherTelemetryCollector {
  const { filePath, subscribe, log } = opts;
  const sessionId = randomUUID();
  // append/rename 이 직렬화되도록 하나의 chain promise 로 큐잉. 다중 이벤트가
  // 짧은 시간에 몰려도 race-free.
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
      // 알 수 없는 schema — drop. 강제 throw 하면 plugin emit 도중 crash 위험.
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
    // 파일 없음 = 첫 write — rotation 불필요.
    return;
  }
  if (size < MAX_FILE_BYTES) return;
  // 단일 백업 슬롯 — `.1` 이미 있으면 덮어씀 (디스크 무한증식 방지).
  await rename(filePath, `${filePath}.1`).catch(() => {});
}
