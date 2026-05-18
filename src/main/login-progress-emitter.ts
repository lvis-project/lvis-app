/**
 * Login progress emitter (Tutorial-X1) —
 *
 * Broadcasts step-by-step progress events on the `lvis:auth:progress`
 * channel so the renderer's LoginModal checklist animates against *real*
 * IPC events instead of a `setTimeout`-driven illusion. Each step has a
 * small inter-step delay so the type-on cadence stays visible to humans
 * (the previous mockup spaced steps over ~1.5s); the delay is configurable
 * for tests via `LoginProgressEmitterOptions.sleep`.
 *
 * Channel: `lvis:auth:progress` (one-way main → renderer broadcast).
 *
 * Payload shape (kebab-case English step ids — Korean UI labels live in
 * the renderer per CLAUDE.md error-language rule):
 *   { step: "credentials-validating", status: "running" | "done" }
 *   { step: "llm-key-issuing",       status: "running" | "done", vendor?: string }
 *   { step: "sandbox-preparing",     status: "running" | "done" }
 *   { step: "complete",              status: "done", vendor: string }
 *   { step: "<any>",                  status: "failed", error: string }
 *
 * Audit prefix: every step emits an audit row with `[auth-progress]` so
 * audit JSONL is greppable for the entire login walkthrough — useful for
 * forensics when a user reports "login stuck on sandbox-preparing".
 */
import type { BrowserWindow } from "electron";
import type { AuditLogger } from "../audit/audit-logger.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("auth-progress");

export const AUTH_PROGRESS_CHANNEL = "lvis:auth:progress";

export type AuthProgressStep =
  | "credentials-validating"
  | "llm-key-issuing"
  | "sandbox-preparing"
  | "complete";

export type AuthProgressStatus = "running" | "done" | "failed";

export interface AuthProgressEvent {
  step: AuthProgressStep;
  status: AuthProgressStatus;
  /** Active vendor (`openai` / `anthropic` / …) once known. */
  vendor?: string;
  /** kebab-case English error code when `status === "failed"`. */
  error?: string;
}

export interface LoginProgressEmitterOptions {
  /**
   * Inter-step delay (ms). Default `120`. Each step emits `running`,
   * waits this long, then emits `done` — the renderer's checklist then
   * paints the ✓ in sync with the *real* main-process step lifecycle.
   * Tests pass a synchronous resolver here.
   */
  stepDelayMs?: number;
  /** Override sleep — set to a sync resolver in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_STEP_DELAY_MS = 120;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Emits a sequence of progress events to every open app window. The
 * sequence + timing is deterministic so the LoginModal's checklist
 * tracks the real main-process steps rather than a renderer setTimeout.
 *
 * Failure semantics: if any step throws, the emitter publishes a
 * `failed` event on the current step + audit entry, then rethrows so
 * the caller (auth IPC handler) can return its existing error code to
 * the renderer. This keeps the existing `loginMockup` contract intact.
 */
export class LoginProgressEmitter {
  private readonly stepDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly getAppWindows: () => Array<BrowserWindow | null | undefined>,
    private readonly auditLogger: AuditLogger,
    opts: LoginProgressEmitterOptions = {},
  ) {
    this.stepDelayMs = opts.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Broadcast a single event and audit it. Tolerates send failures per window. */
  emit(event: AuthProgressEvent): void {
    // Audit row (single source of truth — every fan-out window sees the
    // same event, so we only audit once at broadcast time).
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "auth",
        type: event.status === "failed" ? "warn" : "info",
        input: `[auth-progress] step=${event.step} status=${event.status}${
          event.vendor ? ` vendor=${event.vendor}` : ""
        }${event.error ? ` error=${event.error}` : ""}`,
      });
    } catch {
      /* audit must never break IPC */
    }
    const targets = this.getAppWindows();
    for (const win of targets) {
      if (!win || win.isDestroyed?.()) continue;
      try {
        win.webContents.send(AUTH_PROGRESS_CHANNEL, event);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "progress send failed for one window",
        );
      }
    }
  }

  /**
   * Emit running → wait stepDelayMs → emit done for a single step.
   *
   * The `running` event is emitted first so the renderer paints the
   * spinner before the underlying main-process work happens, then `done`
   * is emitted *after* the work resolves. Callers thread the actual
   * unit-of-work through the optional `work` callback so this method is
   * the single source of truth for "step did real work + UI advanced".
   */
  async runStep<T>(
    step: AuthProgressStep,
    work: () => Promise<T>,
    vendor?: string,
  ): Promise<T> {
    this.emit({ step, status: "running", ...(vendor ? { vendor } : {}) });
    let result: T;
    try {
      result = await work();
    } catch (err) {
      const code = err instanceof Error ? err.message : "unknown";
      this.emit({ step, status: "failed", error: code, ...(vendor ? { vendor } : {}) });
      throw err;
    }
    // Visible-cadence delay so the spinner is perceptible. Skipped when
    // tests pass a sync sleep (the test's sleep resolves immediately, so
    // perception is irrelevant in test runtimes).
    await this.sleep(this.stepDelayMs);
    this.emit({ step, status: "done", ...(vendor ? { vendor } : {}) });
    return result;
  }

  /** Emit the terminal `complete` event so the renderer can collapse the checklist. */
  complete(vendor: string): void {
    this.emit({ step: "complete", status: "done", vendor });
  }

  /** Emit a `failed` event for an arbitrary step + audit it. */
  fail(step: AuthProgressStep, error: string, vendor?: string): void {
    this.emit({ step, status: "failed", error, ...(vendor ? { vendor } : {}) });
  }
}
