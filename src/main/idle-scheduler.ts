/**
 * IdleScheduler — 5-state 머신 + powerMonitor + P0~P4 우선순위 큐
 *
 * 청사진 §6.1 R5 차용 (claw-code + Spotlight + Windows Indexer Backoff).
 * Agent 4의 IdleSchedulerStub 인터페이스 (lvis-plugin-pageindex/src/folderIndexer.ts)와 호환.
 *
 * ## 5-state 머신
 *   RUNNING        — 사용자 활동 중. 큐만 적재, 인덱싱 미실행.
 *   IDLE_SCAN      — 모든 idle 조건 충족. 큐 처리 진행.
 *   THROTTLED      — keystroke 감지. 인덱싱 느리게 (2000ms cooldown).
 *   PAUSED         — suspend/thermal critical/저배터리. 완전 정지.
 *   RESUME_DELAY   — resume 후 90초 대기, 이후 RUNNING 복귀 → 조건 재평가.
 *
 * ## 진입 조건 (→ IDLE_SCAN)
 *   - powerMonitor.getSystemIdleTime() ≥ 60s
 *   - CPU 5분 EMA < 40%
 *   - 마지막 대화 ≥ 30s 경과
 *   - onAC OR battery > 50%
 *
 * ## 종료 조건
 *   - keystroke 감지 → THROTTLED
 *   - 조건 미충족 → RUNNING
 *   - suspend/thermal-critical → PAUSED
 *
 * ## 우선순위 큐
 *   P0: 방금 연 문서 (real-time)
 *   P1: 최근 7일 접근 (real-time)
 *   P2: 중요 태그/파일 변경 감지 (FolderAutoIndexer 기본)
 *   P3: 배경 변경 감지
 *   P4: orphan cleanup (batch)
 *
 * ## Integration
 *   1. boot.ts: new IdleSchedulerService({ workerClient, powerMonitor });
 *   2. boot.ts: idleScheduler.start();
 *   3. hostPlugin.setIdleScheduler(idleScheduler);   // folderIndexer로 주입
 *   4. conversation-loop.ts runTurn() 말미: idleScheduler.signalConversation();
 *
 * ## Testability
 *   powerMonitor는 IdleSchedulerOptions.powerMonitor로 주입받아 mock 가능.
 *   Electron runtime 외에서도 테스트할 수 있음.
 */

import * as os from "node:os";

// ─── Types ──────────────────────────────────────────

export type IdleState =
  | "RUNNING"
  | "IDLE_SCAN"
  | "THROTTLED"
  | "PAUSED"
  | "RESUME_DELAY";

export type Priority = 0 | 1 | 2 | 3 | 4;

/** Agent 4의 IdleSchedulerStub 인터페이스와 호환되는 job shape */
export interface IndexJob {
  filePath: string;
  mode: string; // "auto" | "pdf" | "md" | "docx" | "pptx" | "xlsx" | "txt" | "html"
  priority: number; // 0-4
  enqueuedAt?: number;
}

/** WorkerClient의 최소 구독 서브셋 — 실제 인스턴스는 `Pick`으로 대입 가능 */
export interface WorkerClientLite {
  enqueue(
    filePath: string,
    mode?: string,
    priority?: number,
  ): Promise<{ queued: boolean; queue_size: number }>;
  processOne(
    priority?: number,
  ): Promise<{ processed: boolean; result?: unknown; reason?: string }>;
  getIndexerState(): Promise<{
    queue_size: number;
    processed: number;
    failed: number;
    enqueued: number;
  }>;
}

/**
 * powerMonitor 인터페이스 — Electron electron.powerMonitor를 주입하거나
 * 테스트에서 FakePowerMonitor를 주입할 수 있도록 분리.
 */
export interface PowerMonitorLike {
  /** systemIdleTime (초) */
  getSystemIdleTime(): number;
  /** 배터리 전원 상태 */
  onBatteryPower?: boolean;
  /** 이벤트 구독 */
  on(event: string, handler: (...args: any[]) => void): unknown;
  /** 이벤트 해제 */
  removeAllListeners(event?: string): unknown;
}

export interface IdleSchedulerOptions {
  workerClient: WorkerClientLite;
  /** Electron powerMonitor (test에서는 FakePowerMonitor) */
  powerMonitor?: PowerMonitorLike;
  idleThresholdSec?: number; // default 60
  cpuEmaAlpha?: number; // default 0.1 (EMA 계수)
  cpuEmaThreshold?: number; // default 0.40
  cpuSpikeThreshold?: number; // default 0.70
  batteryFloor?: number; // default 0.20 (20%)
  batteryIdleFloor?: number; // default 0.50 (50%)
  conversationCooldownMs?: number; // default 30000
  /**
   * cycle 1 MED: keystroke 쿨다운을 대화 쿨다운과 분리.
   * THROTTLED 상태에서 마지막 keystroke로부터 이 시간이 경과하면 IDLE_SCAN 재진입 조건 재평가.
   * default 10000 (10s).
   */
  keystrokeCooldownMs?: number;
  chunkCooldownMs?: number; // default 200
  throttledCooldownMs?: number; // default 2000
  resumeDelayMs?: number; // default 90000
  tickIntervalMs?: number; // default 1000
  /** 로그 기록 (기본: console.log) */
  logger?: (message: string) => void;
}

// ─── IdleSchedulerService ────────────────────────────

export class IdleSchedulerService {
  private state: IdleState = "RUNNING";
  private queue: IndexJob[] = [];
  private cpuEma = 0;
  private lastConversationAt = 0;
  private lastKeystrokeAt = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private prevCpuTimes: ReturnType<typeof os.cpus> = [];
  private processing = false;
  private powerSubscribed = false;
  private readonly listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  // 파라미터 (기본값 확정)
  private readonly idleThresholdSec: number;
  private readonly cpuEmaAlpha: number;
  private readonly cpuEmaThreshold: number;
  private readonly cpuSpikeThreshold: number;
  private readonly batteryFloor: number;
  private readonly batteryIdleFloor: number;
  private readonly conversationCooldownMs: number;
  private readonly keystrokeCooldownMs: number;
  private readonly chunkCooldownMs: number;
  private readonly throttledCooldownMs: number;
  private readonly resumeDelayMs: number;
  private readonly tickIntervalMs: number;
  private readonly logger: (message: string) => void;

  constructor(private readonly opts: IdleSchedulerOptions) {
    this.idleThresholdSec = opts.idleThresholdSec ?? 60;
    this.cpuEmaAlpha = opts.cpuEmaAlpha ?? 0.1;
    this.cpuEmaThreshold = opts.cpuEmaThreshold ?? 0.4;
    this.cpuSpikeThreshold = opts.cpuSpikeThreshold ?? 0.7;
    this.batteryFloor = opts.batteryFloor ?? 0.2;
    this.batteryIdleFloor = opts.batteryIdleFloor ?? 0.5;
    this.conversationCooldownMs = opts.conversationCooldownMs ?? 30_000;
    // cycle 1 MED: keystroke 쿨다운을 대화 쿨다운과 분리 (기존: 재사용).
    this.keystrokeCooldownMs = opts.keystrokeCooldownMs ?? 10_000;
    this.chunkCooldownMs = opts.chunkCooldownMs ?? 200;
    this.throttledCooldownMs = opts.throttledCooldownMs ?? 2000;
    this.resumeDelayMs = opts.resumeDelayMs ?? 90_000;
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000;
    this.logger = opts.logger ?? ((msg) => console.log(msg));
    this.prevCpuTimes = os.cpus();
  }

  /**
   * Agent 4의 `IdleSchedulerStub.enqueue`와 호환되는 엔트리 포인트.
   * folderIndexer가 이 시그니처로 호출.
   */
  enqueue(job: { filePath: string; mode: string; priority: number }): void {
    this.queue.push({ ...job, enqueuedAt: Date.now() });
    // priority sort (P0 first), 동일 priority는 FIFO
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0);
    });
  }

  start(): void {
    if (this.tickTimer) return;

    const pm = this.opts.powerMonitor;
    if (pm && !this.powerSubscribed) {
      this.subscribeListener(pm, "suspend", () => this._transition("PAUSED", "suspend"));
      this.subscribeListener(pm, "resume", () => this._transition("RESUME_DELAY", "resume"));
      this.subscribeListener(pm, "on-ac", () => this._reevaluate("on-ac"));
      this.subscribeListener(pm, "on-battery", () => this._reevaluate("on-battery"));
      // thermal-state-change는 macOS only — try/catch
      try {
        this.subscribeListener(pm, "thermal-state-change", (thermalState: string) => {
          if (thermalState === "critical" || thermalState === "serious") {
            this._transition("PAUSED", `thermal-${thermalState}`);
          }
        });
      } catch {
        /* not supported on platform */
      }
      this.powerSubscribed = true;
    }

    this.tickTimer = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const pm = this.opts.powerMonitor;
    if (pm && this.powerSubscribed) {
      // 구독한 리스너만 제거하여 공유 powerMonitor에 영향 최소화
      for (const { event, handler } of this.listeners) {
        const anyPm = pm as unknown as {
          removeListener?: (e: string, h: (...args: any[]) => void) => void;
        };
        if (typeof anyPm.removeListener === "function") {
          try {
            anyPm.removeListener(event, handler);
          } catch {
            /* ignore */
          }
        }
      }
      this.listeners.length = 0;
      this.powerSubscribed = false;
    }
  }

  /** ConversationLoop가 turn 완료 시 호출 */
  signalConversation(): void {
    this.lastConversationAt = Date.now();
    if (this.state === "IDLE_SCAN") {
      this._transition("RUNNING", "conversation");
    }
  }

  /** Renderer/IPC가 keystroke 감지 시 호출 */
  signalKeystroke(): void {
    this.lastKeystrokeAt = Date.now();
    if (this.state === "IDLE_SCAN") {
      this._transition("THROTTLED", "keystroke");
    }
  }

  getState(): IdleState {
    return this.state;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /** 현재 큐의 복사본 (관측용, 변이 금지) */
  peekQueue(): readonly IndexJob[] {
    return this.queue.slice();
  }

  getMetrics(): {
    state: IdleState;
    cpuEma: number;
    queueLength: number;
    lastConversationAt: number;
    lastKeystrokeAt: number;
  } {
    return {
      state: this.state,
      cpuEma: this.cpuEma,
      queueLength: this.queue.length,
      lastConversationAt: this.lastConversationAt,
      lastKeystrokeAt: this.lastKeystrokeAt,
    };
  }

  // ─── Test hooks (internal, protected semantics) ───

  /**
   * 테스트 전용: 내부 tick을 수동 호출. 실제 setInterval 없이 단위 테스트 가능.
   * 프로덕션 코드는 start()를 사용할 것.
   */
  _testTick(): void {
    this._tick();
  }

  /** 테스트 전용: 단일 job 처리. */
  async _testProcessOne(): Promise<void> {
    await this._processOne();
  }

  /** 테스트 전용: 상태 강제 전이. */
  _testForceTransition(newState: IdleState, reason = "test"): void {
    this._transition(newState, reason);
  }

  /** 테스트 전용: cpuEma 강제 설정. */
  _testSetCpuEma(value: number): void {
    this.cpuEma = value;
  }

  /** 테스트 전용: 대화/키 마지막 시각 강제 설정. */
  _testSetLastConversation(ts: number): void {
    this.lastConversationAt = ts;
  }

  /** 테스트 전용: 조건 재평가 트리거. */
  _testReevaluate(reason = "test"): void {
    this._reevaluate(reason);
  }

  // ─── Private ─────────────────────────────────────

  private subscribeListener(
    pm: PowerMonitorLike,
    event: string,
    handler: (...args: any[]) => void,
  ): void {
    pm.on(event, handler);
    this.listeners.push({ event, handler });
  }

  private _tick(): void {
    this._updateCpuEma();
    this._reevaluate("tick");

    if (this.state === "IDLE_SCAN" && this.queue.length > 0 && !this.processing) {
      void this._processOne().catch((err) => {
        this.logger(
          `[idle-scheduler] process_one error: ${(err as Error).message ?? String(err)}`,
        );
      });
    }
  }

  private _updateCpuEma(): void {
    // os.cpus()의 idle/total 차이로 간이 CPU 사용률 계산
    const now = os.cpus();
    let totalDelta = 0;
    let idleDelta = 0;
    for (let i = 0; i < now.length; i++) {
      const prev = this.prevCpuTimes[i];
      if (!prev) continue;
      const nowTotal = Object.values(now[i].times).reduce((a, b) => a + b, 0);
      const prevTotal = Object.values(prev.times).reduce((a, b) => a + b, 0);
      totalDelta += nowTotal - prevTotal;
      idleDelta += now[i].times.idle - prev.times.idle;
    }
    if (totalDelta > 0) {
      const usage = 1 - idleDelta / totalDelta;
      // EMA (α 기본 0.1, 5분 window 근사)
      this.cpuEma = this.cpuEma * (1 - this.cpuEmaAlpha) + usage * this.cpuEmaAlpha;
    }
    this.prevCpuTimes = now;
  }

  private async _processOne(): Promise<void> {
    if (this.processing) return;
    const job = this.queue.shift();
    if (!job) return;
    this.processing = true;
    try {
      await this.opts.workerClient.enqueue(job.filePath, job.mode, job.priority);
      await this.opts.workerClient.processOne();
      // chunk cooldown — THROTTLED는 느리게, IDLE_SCAN은 기본
      const cooldown =
        this.state === "THROTTLED" ? this.throttledCooldownMs : this.chunkCooldownMs;
      if (cooldown > 0) {
        await new Promise<void>((r) => setTimeout(r, cooldown));
      }
    } catch (err) {
      // 실패 시 로그만, 재시도/DLQ는 Phase 1.5 이후
      this.logger(
        `[idle-scheduler] enqueue/process failed for ${job.filePath}: ${(err as Error).message ?? String(err)}`,
      );
    } finally {
      this.processing = false;
    }
  }

  private _transition(newState: IdleState, reason: string): void {
    if (this.state === newState) return;
    const old = this.state;
    this.state = newState;
    this.logger(`[idle-scheduler] ${old} → ${newState} (${reason})`);

    if (newState === "RESUME_DELAY") {
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        this._transition("RUNNING", "resume-delay-end");
        this._reevaluate("post-resume");
      }, this.resumeDelayMs);
    }
  }

  private _reevaluate(_reason: string): void {
    // PAUSED/RESUME_DELAY는 자동 재평가에서 빠지지 않음 — 명시적 transition 필요
    if (this.state === "PAUSED" || this.state === "RESUME_DELAY") return;

    const pm = this.opts.powerMonitor;

    // CPU spike 감지 (10초 평균 상회) → THROTTLED
    if (this.state === "IDLE_SCAN" && this.cpuEma > this.cpuSpikeThreshold) {
      this._transition("THROTTLED", `cpu-spike ${this.cpuEma.toFixed(2)}`);
      return;
    }

    // Battery 저전력 + unplugged → PAUSED
    if (pm && pm.onBatteryPower === true) {
      // battery level은 Electron API 직접 지원 없음 — onBatteryPower만 신뢰.
      // 저배터리 강제 정지는 HostApi.getBatteryLevel() 등 후속 확장 시 추가.
      // 현 단계: onBattery이면 IDLE_SCAN 진입 차단 (배터리 보호).
      if (this.state === "IDLE_SCAN") {
        this._transition("RUNNING", "on-battery");
        return;
      }
    }

    // idle 조건 평가
    const idleSec = pm ? pm.getSystemIdleTime() : 0;
    const conversationOk =
      this.lastConversationAt === 0 ||
      Date.now() - this.lastConversationAt > this.conversationCooldownMs;
    const cpuOk = this.cpuEma < this.cpuEmaThreshold;
    const onAC = !pm || pm.onBatteryPower !== true;
    const idleOk = idleSec >= this.idleThresholdSec;

    const conditionsMet = idleOk && cpuOk && conversationOk && onAC;

    if (conditionsMet && this.state !== "IDLE_SCAN") {
      this._transition(
        "IDLE_SCAN",
        `idle idleSec=${idleSec} cpuEma=${this.cpuEma.toFixed(2)} convOk=${conversationOk} onAC=${onAC}`,
      );
    } else if (!conditionsMet && this.state === "IDLE_SCAN") {
      // 조건 불충족 시 RUNNING 복귀 (THROTTLED는 별도 트리거)
      this._transition("RUNNING", "conditions no longer met");
    } else if (this.state === "THROTTLED") {
      // THROTTLED 상태에서 일정 시간 keystroke 없고 조건 충족 시 IDLE_SCAN 재진입.
      // cycle 1 MED: keystrokeCooldownMs 전용 상수 사용 (기존: conversationCooldownMs 재사용).
      const sinceKey = Date.now() - this.lastKeystrokeAt;
      if (sinceKey > this.keystrokeCooldownMs && conditionsMet) {
        this._transition("IDLE_SCAN", "throttle-cooled");
      }
    }
  }
}
