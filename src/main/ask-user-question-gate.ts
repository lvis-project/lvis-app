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
  timer: ReturnType<typeof setTimeout>;
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

export class AskUserQuestionGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;

  constructor(
    private readonly webContents: WebContents,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.timeoutMs = timeoutMs;
  }

  ask(input: {
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    urgent?: boolean;
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
    if (this.webContents.isDestroyed()) {
      return Promise.resolve({ requestId: req.id, dismissed: true });
    }
    return new Promise<AskUserQuestionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        // M2: notify the renderer so it drops the stale card.
        try {
          if (!this.webContents.isDestroyed()) {
            this.webContents.send(IPC_ASK_USER_QUESTION_TIMEOUT, {
              requestId: req.id,
            });
          }
        } catch {
          // ignore — even if send fails the resolve below clears the gate
        }
        resolve({ requestId: req.id, dismissed: true });
      }, this.timeoutMs);
      this.pending.set(req.id, { resolve, timer });
      try {
        this.webContents.send(IPC_ASK_USER_QUESTION_REQUEST, req);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
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
    clearTimeout(entry.timer);
    this.pending.delete(response.requestId);
    entry.resolve(response);
  }

  disposeAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ requestId: id, dismissed: true });
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
