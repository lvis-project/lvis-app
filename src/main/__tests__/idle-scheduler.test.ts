/**
 * IdleSchedulerService — 5-state 전이 + 우선순위 큐 테스트
 *
 * 청사진 §6.1 Agent 5: `lvis-app/src/main/__tests__/idle-scheduler.test.ts`
 *
 * 실행: `cd lvis-app && npm test`
 *
 * SECURITY_GATE: 5-state 전이 로직 회귀 방지 게이트.
 * KNOWLEDGE_DEPTH_CAP/IdleScheduler 핵심 전이 변경 시 반드시 이 스위트가 green이어야 함.
 *
 * 검증 케이스 20개:
 *   1) enqueue priority sort — P0 먼저, FIFO 보존
 *   2) enqueue 동일 priority → enqueuedAt 순서
 *   3) signalKeystroke → IDLE_SCAN에서 THROTTLED 전환
 *   4) signalConversation → IDLE_SCAN에서 RUNNING 전환
 *   5) 내부 _tick은 idle 조건 충족 시 IDLE_SCAN으로 전환
 *   6) 빈 큐 + IDLE_SCAN → workerClient 미호출
 *   7) 큐에 job 있으면 workerClient.enqueue + processOne 호출
 *   8) transition same-state → no-op + 로그 스킵
 *   9) PAUSED 상태에서는 _reevaluate 무시
 *  10) suspend → PAUSED, resume → RESUME_DELAY
 *  11) RESUME_DELAY 타이머 만료 → RUNNING
 *  12) onBattery + IDLE_SCAN → RUNNING 강등
 *  13) CPU spike (cpuEma > 0.7) + IDLE_SCAN → THROTTLED
 *  14) getMetrics shape
 *  15) stop 후 listener 해제
 *  16) conversationCooldown 미만이면 IDLE_SCAN 진입 차단
 *  17) P0 job이 P3보다 먼저 처리됨
 *  18) worker 실패 시 다음 job으로 진행
 *  19) 전체 전이 시퀀스
 *  20) signalConversation은 RUNNING에서 state 변경 없음
 */
import { describe, it, expect } from "vitest";
import { strict as assert } from "node:assert";

import {
  IdleSchedulerService,
  type IdleState,
  type PowerMonitorLike,
  type WorkerClientLite,
} from "../idle-scheduler.js";

// ─── Mock WorkerClient ────────────────────────────

interface EnqueueCall {
  filePath: string;
  mode: string | undefined;
  priority: number | undefined;
}

function makeMockWorker(): WorkerClientLite & {
  enqueueCalls: EnqueueCall[];
  processCount: number;
  failOnEnqueue: boolean;
  reset(): void;
} {
  const state = {
    enqueueCalls: [] as EnqueueCall[],
    processCount: 0,
    failOnEnqueue: false,
  };
  return {
    get enqueueCalls() {
      return state.enqueueCalls;
    },
    get processCount() {
      return state.processCount;
    },
    set failOnEnqueue(v: boolean) {
      state.failOnEnqueue = v;
    },
    get failOnEnqueue() {
      return state.failOnEnqueue;
    },
    reset() {
      state.enqueueCalls = [];
      state.processCount = 0;
      state.failOnEnqueue = false;
    },
    async enqueue(filePath: string, mode?: string, priority?: number) {
      if (state.failOnEnqueue) throw new Error("mock enqueue fail");
      state.enqueueCalls.push({ filePath, mode, priority });
      return { queued: true, queue_size: 1 };
    },
    async processOne() {
      state.processCount++;
      return { processed: true };
    },
    async getIndexerState() {
      return {
        queue_size: 0,
        processed: state.processCount,
        failed: 0,
        enqueued: state.enqueueCalls.length,
      };
    },
  };
}

// ─── Mock powerMonitor ─────────────────────────────

class FakePowerMonitor implements PowerMonitorLike {
  onBatteryPower = false;
  private idleTimeSec = 0;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  setIdleTime(seconds: number): void {
    this.idleTimeSec = seconds;
  }

  getSystemIdleTime(): number {
    return this.idleTimeSec;
  }

  on(event: string, handler: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
    return this;
  }

  removeListener(event: string, handler: (...args: any[]) => void): this {
    const arr = this.handlers.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    const arr = this.handlers.get(event);
    if (!arr) return;
    for (const h of arr.slice()) h(...args);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

// ─── 헬퍼 ───────────────────────────────────────────

function makeService(
  overrides: { powerMonitor?: FakePowerMonitor; worker?: ReturnType<typeof makeMockWorker> } = {},
): {
  sched: IdleSchedulerService;
  pm: FakePowerMonitor;
  worker: ReturnType<typeof makeMockWorker>;
} {
  const pm = overrides.powerMonitor ?? new FakePowerMonitor();
  const worker = overrides.worker ?? makeMockWorker();
  const logs: string[] = [];
  const sched = new IdleSchedulerService({
    workerClient: worker,
    powerMonitor: pm,
    tickIntervalMs: 1_000_000,
    chunkCooldownMs: 0,
    throttledCooldownMs: 0,
    logger: (m) => logs.push(m),
  });
  return { sched, pm, worker };
}

describe("SECURITY_GATE: IdleSchedulerService 5-state", () => {
  it("case 1: enqueue priority sort — P0 먼저", () => {
    const { sched } = makeService();
    sched.enqueue({ filePath: "/a.md", mode: "md", priority: 3 });
    sched.enqueue({ filePath: "/b.md", mode: "md", priority: 0 });
    sched.enqueue({ filePath: "/c.md", mode: "md", priority: 1 });
    const q = sched.peekQueue();
    expect(q.length).toBe(3);
    expect(q[0].priority).toBe(0);
    expect(q[0].filePath).toBe("/b.md");
    expect(q[1].priority).toBe(1);
    expect(q[2].priority).toBe(3);
  });

  it("case 2: enqueue 동일 priority는 enqueuedAt FIFO", () => {
    const { sched } = makeService();
    sched.enqueue({ filePath: "/first.md", mode: "md", priority: 2 });
    sched.enqueue({ filePath: "/second.md", mode: "md", priority: 2 });
    sched.enqueue({ filePath: "/third.md", mode: "md", priority: 2 });
    const q = sched.peekQueue();
    expect(q[0].filePath).toBe("/first.md");
    expect(q[1].filePath).toBe("/second.md");
    expect(q[2].filePath).toBe("/third.md");
  });

  it("case 3: signalKeystroke → IDLE_SCAN에서 THROTTLED 전환", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-entry");
    expect(sched.getState()).toBe("IDLE_SCAN");
    sched.signalKeystroke();
    expect(sched.getState()).toBe("THROTTLED");
  });

  it("case 4: signalConversation → IDLE_SCAN에서 RUNNING 전환", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-entry");
    sched.signalConversation();
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 5: _tick이 idle 조건 충족 시 IDLE_SCAN 진입", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    expect(sched.getState()).toBe("IDLE_SCAN");
  });

  it("case 6: IDLE_SCAN + 빈 큐 → workerClient 미호출", async () => {
    const { sched, worker } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-case");
    sched._testTick();
    await new Promise((r) => setTimeout(r, 10));
    expect(worker.processCount).toBe(0);
    expect(worker.enqueueCalls.length).toBe(0);
  });

  it("case 7: IDLE_SCAN + 큐 존재 → workerClient.enqueue + processOne 호출", async () => {
    const { sched, worker } = makeService();
    sched.enqueue({ filePath: "/doc.pdf", mode: "pdf", priority: 0 });
    sched._testForceTransition("IDLE_SCAN", "test-case");
    await sched._testProcessOne();
    expect(worker.enqueueCalls.length).toBe(1);
    expect(worker.enqueueCalls[0].filePath).toBe("/doc.pdf");
    expect(worker.enqueueCalls[0].mode).toBe("pdf");
    expect(worker.enqueueCalls[0].priority).toBe(0);
    expect(worker.processCount).toBe(1);
  });

  it("case 8: transition same-state는 no-op", () => {
    const logs: string[] = [];
    const pm = new FakePowerMonitor();
    const worker = makeMockWorker();
    const sched = new IdleSchedulerService({
      workerClient: worker,
      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      logger: (m) => logs.push(m),
    });
    sched._testForceTransition("RUNNING", "first");
    const before = logs.length;
    sched._testForceTransition("RUNNING", "second");
    expect(logs.length).toBe(before);
  });

  it("case 9: PAUSED 상태는 _reevaluate 무시", () => {
    const { sched, pm } = makeService();
    sched._testForceTransition("PAUSED", "suspend");
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testReevaluate("force");
    expect(sched.getState()).toBe("PAUSED");
  });

  it("case 10: suspend → PAUSED, resume → RESUME_DELAY", () => {
    const { sched, pm } = makeService();
    sched.start();
    pm.emit("suspend");
    expect(sched.getState()).toBe("PAUSED");
    pm.emit("resume");
    expect(sched.getState()).toBe("RESUME_DELAY");
    sched.stop();
  });

  it("case 11: RESUME_DELAY 타이머 만료 → RUNNING", async () => {
    const pm = new FakePowerMonitor();
    const worker = makeMockWorker();
    const sched = new IdleSchedulerService({
      workerClient: worker,
      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      resumeDelayMs: 30,
      chunkCooldownMs: 0,
      throttledCooldownMs: 0,
      logger: () => {},
    });
    sched.start();
    pm.emit("resume");
    expect(sched.getState()).toBe("RESUME_DELAY");
    await new Promise((r) => setTimeout(r, 60));
    expect(sched.getState()).toBe("RUNNING");
    sched.stop();
  });

  it("case 12: onBattery + IDLE_SCAN → RUNNING 강등", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    expect(sched.getState()).toBe("IDLE_SCAN");
    pm.onBatteryPower = true;
    sched._testReevaluate("battery-switch");
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 13: CPU spike (cpuEma > 0.7) + IDLE_SCAN → THROTTLED", () => {
    const { sched } = makeService();
    sched._testForceTransition("IDLE_SCAN", "test-case");
    sched._testSetCpuEma(0.85);
    sched._testReevaluate("cpu-spike-force");
    expect(sched.getState()).toBe("THROTTLED");
  });

  it("case 14: getMetrics shape", () => {
    const { sched } = makeService();
    sched.enqueue({ filePath: "/x.md", mode: "md", priority: 2 });
    const m = sched.getMetrics();
    expect(m.state).toBe("RUNNING");
    expect(m.queueLength).toBe(1);
    expect(typeof m.cpuEma).toBe("number");
    expect(typeof m.lastConversationAt).toBe("number");
    expect(typeof m.lastKeystrokeAt).toBe("number");
  });

  it("case 15: stop 후 powerMonitor 리스너 해제", () => {
    const pm = new FakePowerMonitor();
    const worker = makeMockWorker();
    const sched = new IdleSchedulerService({
      workerClient: worker,
      powerMonitor: pm,
      tickIntervalMs: 1_000_000,
      logger: () => {},
    });
    sched.start();
    expect(pm.listenerCount("suspend")).toBeGreaterThan(0);
    sched.stop();
    expect(pm.listenerCount("suspend")).toBe(0);
    expect(pm.listenerCount("resume")).toBe(0);
  });

  it("case 16: conversationCooldown 미만이면 IDLE_SCAN 진입 차단", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testSetLastConversation(Date.now() - 10_000);
    sched._testTick();
    expect(sched.getState()).toBe("RUNNING");
  });

  it("case 17: P0 job이 P3보다 먼저 처리됨", async () => {
    const { sched, worker } = makeService();
    sched.enqueue({ filePath: "/low.md", mode: "md", priority: 3 });
    sched.enqueue({ filePath: "/urgent.md", mode: "md", priority: 0 });
    sched.enqueue({ filePath: "/mid.md", mode: "md", priority: 2 });
    sched._testForceTransition("IDLE_SCAN", "test-case");
    await sched._testProcessOne();
    await sched._testProcessOne();
    await sched._testProcessOne();
    expect(worker.enqueueCalls.length).toBe(3);
    expect(worker.enqueueCalls[0].filePath).toBe("/urgent.md");
    expect(worker.enqueueCalls[1].filePath).toBe("/mid.md");
    expect(worker.enqueueCalls[2].filePath).toBe("/low.md");
  });

  it("case 18: worker 실패 시 다음 job으로 진행", async () => {
    const { sched, worker } = makeService();
    sched.enqueue({ filePath: "/bad.md", mode: "md", priority: 0 });
    sched.enqueue({ filePath: "/good.md", mode: "md", priority: 1 });
    worker.failOnEnqueue = true;
    sched._testForceTransition("IDLE_SCAN", "test-case");
    await sched._testProcessOne();
    worker.failOnEnqueue = false;
    await sched._testProcessOne();
    expect(worker.enqueueCalls.length).toBe(1);
    expect(worker.enqueueCalls[0].filePath).toBe("/good.md");
  });

  it("case 19: 전체 전이 시퀀스 RUNNING → IDLE_SCAN → THROTTLED → IDLE_SCAN", () => {
    const { sched, pm } = makeService();
    pm.setIdleTime(120);
    pm.onBatteryPower = false;
    sched._testSetCpuEma(0.1);
    sched._testTick();
    const seq: IdleState[] = [sched.getState()];
    sched.signalKeystroke();
    seq.push(sched.getState());
    sched._testSetLastConversation(0);
    (sched as unknown as { lastKeystrokeAt: number }).lastKeystrokeAt = Date.now() - 60_000;
    sched._testReevaluate("cooled");
    seq.push(sched.getState());
    assert.deepEqual(seq, ["IDLE_SCAN", "THROTTLED", "IDLE_SCAN"]);
  });

  it("case 20: signalConversation은 RUNNING에서는 state 변경 없음", () => {
    const { sched } = makeService();
    expect(sched.getState()).toBe("RUNNING");
    sched.signalConversation();
    expect(sched.getState()).toBe("RUNNING");
  });
});
