/**
 * IdleSchedulerService — 5-state 전이 + 우선순위 큐 테스트
 *
 * 청사진 §6.1 Agent 5: `lvis-app/src/main/__tests__/idle-scheduler.test.ts`
 *
 * 실행:
 *   cd lvis-app && npx tsx src/main/__tests__/idle-scheduler.test.ts
 *
 * 기존 hybrid-retriever.test.ts 패턴 (node:assert + 수동 러너) 사용.
 *
 * 검증 케이스:
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
 */

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

  /** 테스트에서 이벤트 강제 발화 */
  emit(event: string, ...args: any[]): void {
    const arr = this.handlers.get(event);
    if (!arr) return;
    for (const h of arr.slice()) h(...args);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

// ─── 러너 ───────────────────────────────────────────

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

async function runAll(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(err as Error).message}`);
      if ((err as Error).stack) {
        console.error((err as Error).stack!.split("\n").slice(1, 4).join("\n"));
      }
      failed++;
    }
  }
  console.log();
  console.log(`Total: ${tests.length}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
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
    // tick interval을 큰 값으로 → setInterval 참조가 테스트 프로세스를 잡지 않도록 _testTick만 사용
    tickIntervalMs: 1_000_000,
    chunkCooldownMs: 0,
    throttledCooldownMs: 0,
    logger: (m) => logs.push(m),
  });
  return { sched, pm, worker };
}

// ─── 테스트 케이스 ──────────────────────────────────

test("case 1: enqueue priority sort — P0 먼저", () => {
  const { sched } = makeService();
  sched.enqueue({ filePath: "/a.md", mode: "md", priority: 3 });
  sched.enqueue({ filePath: "/b.md", mode: "md", priority: 0 });
  sched.enqueue({ filePath: "/c.md", mode: "md", priority: 1 });
  const q = sched.peekQueue();
  assert.equal(q.length, 3);
  assert.equal(q[0].priority, 0);
  assert.equal(q[0].filePath, "/b.md");
  assert.equal(q[1].priority, 1);
  assert.equal(q[2].priority, 3);
});

test("case 2: enqueue 동일 priority는 enqueuedAt FIFO", () => {
  const { sched } = makeService();
  sched.enqueue({ filePath: "/first.md", mode: "md", priority: 2 });
  sched.enqueue({ filePath: "/second.md", mode: "md", priority: 2 });
  sched.enqueue({ filePath: "/third.md", mode: "md", priority: 2 });
  const q = sched.peekQueue();
  assert.equal(q[0].filePath, "/first.md");
  assert.equal(q[1].filePath, "/second.md");
  assert.equal(q[2].filePath, "/third.md");
});

test("case 3: signalKeystroke → IDLE_SCAN에서 THROTTLED 전환", () => {
  const { sched } = makeService();
  sched._testForceTransition("IDLE_SCAN", "test-entry");
  assert.equal(sched.getState(), "IDLE_SCAN");
  sched.signalKeystroke();
  assert.equal(sched.getState(), "THROTTLED");
});

test("case 4: signalConversation → IDLE_SCAN에서 RUNNING 전환", () => {
  const { sched } = makeService();
  sched._testForceTransition("IDLE_SCAN", "test-entry");
  sched.signalConversation();
  assert.equal(sched.getState(), "RUNNING");
});

test("case 5: _tick이 idle 조건 충족 시 IDLE_SCAN 진입", () => {
  const { sched, pm } = makeService();
  pm.setIdleTime(120); // 60s 넘음
  pm.onBatteryPower = false;
  sched._testSetCpuEma(0.1); // < 0.40
  // conversationCooldown 기본 30s, lastConversationAt=0이면 통과
  sched._testTick();
  assert.equal(sched.getState(), "IDLE_SCAN");
});

test("case 6: IDLE_SCAN + 빈 큐 → workerClient 미호출", async () => {
  const { sched, worker } = makeService();
  sched._testForceTransition("IDLE_SCAN", "test");
  sched._testTick();
  // 비동기 호출 대기
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(worker.processCount, 0);
  assert.equal(worker.enqueueCalls.length, 0);
});

test("case 7: IDLE_SCAN + 큐 존재 → workerClient.enqueue + processOne 호출", async () => {
  const { sched, worker } = makeService();
  sched.enqueue({ filePath: "/doc.pdf", mode: "pdf", priority: 0 });
  sched._testForceTransition("IDLE_SCAN", "test");
  await sched._testProcessOne();
  assert.equal(worker.enqueueCalls.length, 1);
  assert.equal(worker.enqueueCalls[0].filePath, "/doc.pdf");
  assert.equal(worker.enqueueCalls[0].mode, "pdf");
  assert.equal(worker.enqueueCalls[0].priority, 0);
  assert.equal(worker.processCount, 1);
});

test("case 8: transition same-state는 no-op", () => {
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
  assert.equal(logs.length, before, "로그 증가 없음");
});

test("case 9: PAUSED 상태는 _reevaluate 무시 (자동 transition 없음)", () => {
  const { sched, pm } = makeService();
  sched._testForceTransition("PAUSED", "suspend");
  pm.setIdleTime(120);
  pm.onBatteryPower = false;
  sched._testSetCpuEma(0.1);
  sched._testReevaluate("force");
  assert.equal(sched.getState(), "PAUSED");
});

test("case 10: suspend 이벤트 → PAUSED, resume 이벤트 → RESUME_DELAY", () => {
  const { sched, pm } = makeService();
  sched.start();
  pm.emit("suspend");
  assert.equal(sched.getState(), "PAUSED");
  pm.emit("resume");
  assert.equal(sched.getState(), "RESUME_DELAY");
  sched.stop();
});

test("case 11: RESUME_DELAY 타이머 만료 → RUNNING", async () => {
  const pm = new FakePowerMonitor();
  const worker = makeMockWorker();
  const sched = new IdleSchedulerService({
    workerClient: worker,
    powerMonitor: pm,
    tickIntervalMs: 1_000_000,
    resumeDelayMs: 30, // 빠른 만료
    chunkCooldownMs: 0,
    throttledCooldownMs: 0,
    logger: () => {},
  });
  sched.start();
  pm.emit("resume");
  assert.equal(sched.getState(), "RESUME_DELAY");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sched.getState(), "RUNNING");
  sched.stop();
});

test("case 12: onBattery + IDLE_SCAN → RUNNING 강등", () => {
  const { sched, pm } = makeService();
  pm.setIdleTime(120);
  pm.onBatteryPower = false;
  sched._testSetCpuEma(0.1);
  sched._testTick();
  assert.equal(sched.getState(), "IDLE_SCAN");
  // 배터리 전환
  pm.onBatteryPower = true;
  sched._testReevaluate("battery-switch");
  assert.equal(sched.getState(), "RUNNING");
});

test("case 13: CPU spike (cpuEma > 0.7) + IDLE_SCAN → THROTTLED", () => {
  const { sched } = makeService();
  sched._testForceTransition("IDLE_SCAN", "test");
  sched._testSetCpuEma(0.85);
  sched._testReevaluate("cpu-spike-force");
  assert.equal(sched.getState(), "THROTTLED");
});

test("case 14: getMetrics shape", () => {
  const { sched } = makeService();
  sched.enqueue({ filePath: "/x.md", mode: "md", priority: 2 });
  const m = sched.getMetrics();
  assert.equal(m.state, "RUNNING");
  assert.equal(m.queueLength, 1);
  assert.ok(typeof m.cpuEma === "number");
  assert.ok(typeof m.lastConversationAt === "number");
  assert.ok(typeof m.lastKeystrokeAt === "number");
});

test("case 15: stop 후 powerMonitor 리스너 해제", () => {
  const pm = new FakePowerMonitor();
  const worker = makeMockWorker();
  const sched = new IdleSchedulerService({
    workerClient: worker,
    powerMonitor: pm,
    tickIntervalMs: 1_000_000,
    logger: () => {},
  });
  sched.start();
  assert.ok(pm.listenerCount("suspend") > 0, "suspend listener 등록됨");
  sched.stop();
  assert.equal(pm.listenerCount("suspend"), 0, "suspend listener 해제됨");
  assert.equal(pm.listenerCount("resume"), 0, "resume listener 해제됨");
});

test("case 16: conversationCooldown 미만이면 IDLE_SCAN 진입 차단", () => {
  const { sched, pm } = makeService();
  pm.setIdleTime(120);
  pm.onBatteryPower = false;
  sched._testSetCpuEma(0.1);
  sched._testSetLastConversation(Date.now() - 10_000); // 10s 전 (< 30s)
  sched._testTick();
  assert.equal(sched.getState(), "RUNNING");
});

test("case 17: P0 job이 P3보다 먼저 처리됨", async () => {
  const { sched, worker } = makeService();
  sched.enqueue({ filePath: "/low.md", mode: "md", priority: 3 });
  sched.enqueue({ filePath: "/urgent.md", mode: "md", priority: 0 });
  sched.enqueue({ filePath: "/mid.md", mode: "md", priority: 2 });
  sched._testForceTransition("IDLE_SCAN", "test");
  // 3번 process
  await sched._testProcessOne();
  await sched._testProcessOne();
  await sched._testProcessOne();
  assert.equal(worker.enqueueCalls.length, 3);
  assert.equal(worker.enqueueCalls[0].filePath, "/urgent.md");
  assert.equal(worker.enqueueCalls[1].filePath, "/mid.md");
  assert.equal(worker.enqueueCalls[2].filePath, "/low.md");
});

test("case 18: worker 실패 시 다음 job으로 진행 (로그만)", async () => {
  const { sched, worker } = makeService();
  sched.enqueue({ filePath: "/bad.md", mode: "md", priority: 0 });
  sched.enqueue({ filePath: "/good.md", mode: "md", priority: 1 });
  worker.failOnEnqueue = true;
  sched._testForceTransition("IDLE_SCAN", "test");
  await sched._testProcessOne(); // bad.md 실패
  worker.failOnEnqueue = false;
  await sched._testProcessOne(); // good.md 성공
  assert.equal(worker.enqueueCalls.length, 1);
  assert.equal(worker.enqueueCalls[0].filePath, "/good.md");
});

test("case 19: 전체 전이 시퀀스 — RUNNING → IDLE_SCAN → THROTTLED → IDLE_SCAN", () => {
  const { sched, pm } = makeService();
  // RUNNING → IDLE_SCAN
  pm.setIdleTime(120);
  pm.onBatteryPower = false;
  sched._testSetCpuEma(0.1);
  sched._testTick();
  const seq: IdleState[] = [sched.getState()];
  // IDLE_SCAN → THROTTLED
  sched.signalKeystroke();
  seq.push(sched.getState());
  // THROTTLED → IDLE_SCAN (keystroke 오래 전 + 조건 충족)
  sched._testSetLastConversation(0);
  (sched as unknown as { lastKeystrokeAt: number }).lastKeystrokeAt = Date.now() - 60_000;
  sched._testReevaluate("cooled");
  seq.push(sched.getState());
  assert.deepEqual(seq, ["IDLE_SCAN", "THROTTLED", "IDLE_SCAN"]);
});

test("case 20: signalConversation은 RUNNING에서는 state 변경 없음", () => {
  const { sched } = makeService();
  assert.equal(sched.getState(), "RUNNING");
  sched.signalConversation();
  assert.equal(sched.getState(), "RUNNING");
});

// ─── main ──────────────────────────────────────────

console.log("IdleSchedulerService 5-state + priority queue tests");
console.log("====================================================");
runAll().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
