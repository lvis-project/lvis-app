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
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
const log = createLogger("lvis");

/**
 * One question inside a multi-question request. The card surfaces these as
 * a paginated form (1 of N), then a final confirmation page so the user
 * can review every answer before sending.
 */
export interface AskUserQuestionItem {
  question: string;
  /** Up to 3 visible choices, each ≤ 20 Korean chars. */
  choices?: string[];
  /** Index of the model's top recommendation in `choices` (0 or 1 across the array). */
  recommendedIndex?: number;
  /** Indices in `choices` of secondary recommendations (disjoint with recommendedIndex). */
  altIndices?: number[];
  allowFreeText: boolean;
  /**
   * When true, the user may pick more than one of `choices` and the response
   * carries them in `choices: string[]`. Single-select (default) preserves
   * the `choice: string` response shape. Auto-submit on single-question
   * cards is disabled in multi-select mode — the user must press 보내기.
   */
  allowMultiple?: boolean;
  /** Single-line placeholder text for the free-text input (≤ 20 Korean chars). */
  placeholder?: string;
  /** Confirm-step row label override (≤ 10 Korean chars). Falls back to a truncated question. */
  summaryHint?: string;
}

export interface AskUserQuestionRequest {
  id: string;
  questions: AskUserQuestionItem[];
  createdAt: number;
}

/** One answer inside a multi-question response. */
export interface AskUserQuestionAnswer {
  /** Single-select selected label. Mutually exclusive with `choices`. */
  choice?: string;
  /**
   * Multi-select selected labels (only present when the question was
   * declared `allowMultiple: true`). Always a fresh array in request order;
   * empty array is normalized to undefined upstream.
   */
  choices?: string[];
  freeText?: string;
}

export interface AskUserQuestionResponse {
  requestId: string;
  /**
   * Per-question answers, in the same order as the request's `questions`.
   * Length matches `questions.length` when the card is confirmed.
   */
  answers?: AskUserQuestionAnswer[];
  /** Card-level dismissal — every question abandoned at once. */
  dismissed?: boolean;
}

/** 1–4 questions per card. Cap is shared between tool input validation and gate. */
export const MAX_QUESTIONS_PER_CARD = 4;

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
 * Per-session cap on concurrent pending questions. Without this, a
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
    /**
     * 1–4 questions to ask in a single inline card. Anything outside that
     * range is rejected up-front so the renderer never has to defend
     * against malformed multi-question shapes.
     */
    questions: AskUserQuestionItem[];
    /**
     * Per-turn abort signal from the conversation loop. When the user
     * presses 중단 the signal fires and we resolve `dismissed: true` plus
     * notify the renderer so the card disappears — without this, the gate
     * sits on its 5-minute timer and the abort feels like a dead button.
     */
    abortSignal?: AbortSignal;
  }): Promise<AskUserQuestionResponse> {
    if (
      !Array.isArray(input.questions) ||
      input.questions.length === 0 ||
      input.questions.length > MAX_QUESTIONS_PER_CARD
    ) {
      return Promise.resolve({
        requestId: "",
        dismissed: true,
      });
    }
    const req: AskUserQuestionRequest = {
      id: randomUUID(),
      questions: input.questions.map((q) => ({
        question: q.question,
        choices: q.choices,
        recommendedIndex: q.recommendedIndex,
        altIndices: q.altIndices,
        allowFreeText: q.allowFreeText !== false,
        allowMultiple: q.allowMultiple === true ? true : undefined,
        placeholder: q.placeholder,
        summaryHint: q.summaryHint,
      })),
      createdAt: Date.now(),
    };
    // Enforce concurrent-pending cap before scheduling anything.
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
      // For a single question we surface the prompt verbatim; for a
      // multi-question card we surface the count + first prompt so the
      // OS-toast preview is informative but not flooded.
      const previewBody =
        req.questions.length === 1
          ? req.questions[0].question
          : t("be_askUserQuestionGate.multiQuestionPreview", { count: String(req.questions.length), first: req.questions[0].question });
      this.notificationService?.fire({
        kind: "ask-user",
        title: t("be_askUserQuestionGate.notificationTitle"),
        body: previewBody,
        contextRef: { questionId: req.id },
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
        log.warn(
          "ask-user-question send failed: %s",
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
