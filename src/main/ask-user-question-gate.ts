/**
 * AskUserQuestionGate — main-process broker for the `ask_user_question`
 * tool. The tool execution awaits a Promise; this gate sends an inline
 * question payload to the renderer (channel `lvis:ask-user-question:request`)
 * and resolves the promise when the user submits or dismisses.
 *
 * Mirrors {@link ApprovalGate} structurally but does NOT enforce permission
 * policy — the question is rendered as a chat-side card, not a modal,
 * because the tool itself is "ask the user" intent. A 5-minute timeout
 * resolves to `{ dismissed: true }`.
 */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { NotificationService } from "./notification-service.js";

export interface AskUserQuestionRequest {
  id: string;
  question: string;
  choices?: string[];
  allowFreeText: boolean;
  urgent: boolean;
  createdAt: number;
}

export interface AskUserQuestionResponse {
  requestId: string;
  choice?: string;
  freeText?: string;
  dismissed?: boolean;
}

export const IPC_ASK_USER_QUESTION_REQUEST = "lvis:ask-user-question:request";
export const IPC_ASK_USER_QUESTION_RESPOND = "lvis:ask-user-question:respond";

interface PendingEntry {
  resolve: (response: AskUserQuestionResponse) => void;
  /**
   * Centralized teardown — clears the timer, removes the abort listener,
   * and removes this entry from the `pending` map. Called from every
   * terminal path (timeout, abort, send-failure, IPC resolve, disposeAll)
   * so a long-lived `AbortController` reused across multiple sequential
   * questions never leaks listeners.
   */
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * H3: per-session cap on concurrent pending questions. Without this, a
 * misbehaving assistant could chain many `ask_user_question` calls in one
 * turn and bury the renderer in cards. 5 is generous for legitimate
 * workflows (decision tree branches) and tight enough that abuse is
 * obvious.
 */
const MAX_CONCURRENT_PENDING = 5;
/**
 * M2: extra event the renderer listens for so it can drop stale cards
 * when the gate's 5-minute timeout fires before the user clicked.
 */
export const IPC_ASK_USER_QUESTION_TIMEOUT = "lvis:ask-user-question:timeout";

/**
 * Resolved lazily on every send so dev-mode reloads (which destroy the old
 * webContents) don't strand the gate on a stale reference. Boot wires this
 * to `() => getMainWindow()?.webContents ?? null`.
 */
export type WebContentsResolver = () => WebContents | null;

export class AskUserQuestionGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly notificationService?: NotificationService;
  private readonly resolveWebContents: WebContentsResolver;

  constructor(
    webContents: WebContents | WebContentsResolver,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    notificationService?: NotificationService,
  ) {
    this.timeoutMs = timeoutMs;
    this.notificationService = notificationService;
    // Accept either a direct WebContents (legacy/tests) or a resolver
    // function. Direct WebContents is wrapped so the rest of the gate
    // talks to one shape.
    this.resolveWebContents = typeof webContents === "function"
      ? (webContents as WebContentsResolver)
      : () => (webContents.isDestroyed() ? null : webContents);
  }

  ask(input: {
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    urgent?: boolean;
    /**
     * Per-turn abort signal from the conversation loop. When the user
     * presses 중단 the signal fires and we resolve `dismissed: true` plus
     * notify the renderer so the card disappears — without this, the gate
     * sits on its 5-minute timer and the abort feels like a dead button.
     */
    abortSignal?: AbortSignal;
  }): Promise<AskUserQuestionResponse> {
    const req: AskUserQuestionRequest = {
      id: randomUUID(),
      question: input.question,
      choices: input.choices,
      allowFreeText: input.allowFreeText ?? true,
      urgent: input.urgent ?? false,
      createdAt: Date.now(),
    };
    // H3: enforce concurrent-pending cap before scheduling anything.
    if (this.pending.size >= MAX_CONCURRENT_PENDING) {
      return Promise.resolve({
        requestId: req.id,
        dismissed: true,
      });
    }
    const wc = this.resolveWebContents();
    if (!wc) {
      return Promise.resolve({ requestId: req.id, dismissed: true });
    }
    if (input.abortSignal?.aborted) {
      return Promise.resolve({ requestId: req.id, dismissed: true });
    }
    // Issue #260 — fire system notification at the entry of the wait. If
    // the window is focused this becomes an in-app toast; otherwise an OS
    // notification surfaces the question while the user is in another app.
    try {
      this.notificationService?.fire({
        kind: "ask-user",
        title: "질문이 도착했습니다",
        body: req.question,
        contextRef: { questionId: req.id },
        urgent: req.urgent,
      });
    } catch {
      // notification failure must never block the gate
    }
    return new Promise<AskUserQuestionResponse>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        // M2: notify the renderer so it drops the stale card.
        try {
          const live = this.resolveWebContents();
          live?.send(IPC_ASK_USER_QUESTION_TIMEOUT, { requestId: req.id });
        } catch {
          // ignore — even if send fails the resolve below clears the gate
        }
        resolve({ requestId: req.id, dismissed: true });
      }, this.timeoutMs);
      const abortListener = input.abortSignal
        ? () => {
            cleanup();
            try {
              const live = this.resolveWebContents();
              live?.send(IPC_ASK_USER_QUESTION_TIMEOUT, { requestId: req.id });
            } catch {
              /* renderer may be tearing down — best-effort */
            }
            resolve({ requestId: req.id, dismissed: true });
          }
        : null;
      const cleanup = () => {
        this.pending.delete(req.id);
        clearTimeout(timer);
        if (abortListener) input.abortSignal?.removeEventListener("abort", abortListener);
      };
      if (abortListener) {
        input.abortSignal?.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(req.id, { resolve, cleanup });
      try {
        wc.send(IPC_ASK_USER_QUESTION_REQUEST, req);
      } catch (err) {
        cleanup();
        console.warn(
          "[lvis] ask-user-question send failed:",
          (err as Error).message,
        );
        resolve({ requestId: req.id, dismissed: true });
      }
    });
  }

  resolve(response: AskUserQuestionResponse): void {
    const entry = this.pending.get(response.requestId);
    if (!entry) return;
    entry.cleanup();
    entry.resolve(response);
  }

  disposeAll(): void {
    for (const [id, entry] of this.pending) {
      entry.cleanup();
      entry.resolve({ requestId: id, dismissed: true });
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
