/**
 * AskUserQuestionGate — main-process broker for the `ask_user_question`
 * tool. The tool execution awaits a Promise; this gate sends a FIFO question
 * payload to the renderer's non-modal composer dock via
 * `lvis:ask-user-question:request` and resolves on submit or dismiss.
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
import {
  MAX_FREE_TEXT_LENGTH,
  MAX_PLACEHOLDER_LENGTH,
} from "../shared/ask-user-question-limits.js";
import { t } from "../i18n/index.js";
const log = createLogger("lvis");

/**
 * One question inside a multi-question request. The card surfaces these as
 * a paginated form (1 of N), then a final confirmation page so the user
 * can review every answer before sending.
 */
export interface AskUserQuestionItem {
  question: string;
  /**
   * Up to 3 visible choices, each ≤ 20 Korean chars. Empty only when
   * `allowFreeText` is set — every question must offer at least one way to
   * answer, and a free-text field is one.
   */
  choices: string[];
  /** Index of the model's top recommendation in `choices` (0 or 1 across the array). */
  recommendedIndex?: number;
  /** Indices in `choices` of secondary recommendations (disjoint with recommendedIndex). */
  altIndices?: number[];
  allowMultiple?: boolean;
  /**
   * Render a free-text field as the last answer row. This is the only way a
   * typed answer exists: a choice label is a button, so a model that wants
   * typing has to ask for the field rather than name it in `choices`.
   */
  allowFreeText?: boolean;
  /** Placeholder for the free-text field (≤ 40 chars). Only read when `allowFreeText`. */
  placeholder?: string;
  /** Confirm-step row label override (≤ 10 Korean chars). Falls back to a truncated question. */
  summaryHint?: string;
}

export interface AskUserQuestionRequest {
  id: string;
  /**
   * The conversation whose turn asked. The request travels on a WINDOW channel
   * and a window now holds several conversations side by side, so the card can
   * only reach the right one if the request names it. Without it every tile
   * draws the same card, and whichever tile the user answers resolves the gate
   * — leaving the asking tile holding a prompt that can never be answered.
   */
  sessionId: string;
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
  /**
   * What the user typed, present only for a question that declared
   * `allowFreeText`. Kept in its own field rather than folded into
   * `choice`/`choices` so the reader of the result can always tell a label
   * the model itself wrote from text the user typed.
   */
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
  request: AskUserQuestionRequest;
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

function normalizeQuestion(value: unknown): AskUserQuestionItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = value as Record<string, unknown>;
  if (typeof question.question !== "string" || question.question.trim().length === 0) return null;
  const allowFreeText = question.allowFreeText === true;
  if (!Array.isArray(question.choices) || question.choices.length > 3) return null;
  // A question with neither chips nor a typed field renders with no answer at
  // all, leaving the user only the skip button.
  if (question.choices.length === 0 && !allowFreeText) return null;
  if (
    question.choices.some(
      (choice) =>
        typeof choice !== "string" ||
        choice.trim().length === 0 ||
        choice.trim().length > 20,
    )
  ) {
    return null;
  }

  const choices = question.choices.map((choice) => (choice as string).trim());
  if (new Set(choices).size !== choices.length) return null;
  const recommendedIndex =
    Number.isInteger(question.recommendedIndex) &&
    Number(question.recommendedIndex) >= 0 &&
    Number(question.recommendedIndex) < choices.length
      ? Number(question.recommendedIndex)
      : undefined;
  const altIndices = Array.isArray(question.altIndices)
    ? [...new Set(question.altIndices.filter(
        (index): index is number =>
          Number.isInteger(index) &&
          Number(index) >= 0 &&
          Number(index) < choices.length &&
          Number(index) !== recommendedIndex,
      ).map(Number))]
    : undefined;

  const placeholder =
    typeof question.placeholder === "string" ? question.placeholder.trim() : "";

  return {
    question: question.question.trim(),
    choices,
    recommendedIndex,
    altIndices: altIndices && altIndices.length > 0 ? altIndices : undefined,
    allowMultiple: question.allowMultiple === true ? true : undefined,
    allowFreeText: allowFreeText ? true : undefined,
    placeholder:
      allowFreeText && placeholder.length > 0 && placeholder.length <= MAX_PLACEHOLDER_LENGTH
        ? placeholder
        : undefined,
    summaryHint:
      typeof question.summaryHint === "string" && question.summaryHint.trim().length > 0
        ? question.summaryHint.trim()
        : undefined,
  };
}

function normalizeResponse(
  request: AskUserQuestionRequest,
  response: AskUserQuestionResponse,
): AskUserQuestionResponse | null {
  if (response.dismissed === true) {
    return { requestId: request.id, dismissed: true };
  }
  if (!Array.isArray(response.answers) || response.answers.length !== request.questions.length) {
    return null;
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const [index, question] of request.questions.entries()) {
    const answer = response.answers[index];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;

    // Typed text is bound to the request the same way a label is: it is
    // admissible only where the question asked for the field, so a renderer
    // cannot invent an answer channel the model never opened.
    let freeText: string | undefined;
    if (answer.freeText !== undefined) {
      if (question.allowFreeText !== true) return null;
      if (typeof answer.freeText !== "string") return null;
      const typed = answer.freeText.trim();
      if (typed.length === 0 || typed.length > MAX_FREE_TEXT_LENGTH) return null;
      freeText = typed;
    }
    const typedPart = freeText !== undefined ? { freeText } : {};

    if (question.allowMultiple) {
      if (answer.choices !== undefined && !Array.isArray(answer.choices)) return null;
      const picked = answer.choices ?? [];
      if (picked.some((choice) => typeof choice !== "string" || !question.choices.includes(choice))) {
        return null;
      }
      const selected = new Set(picked);
      if (selected.size !== picked.length) return null;
      if (selected.size === 0 && freeText === undefined) return null;
      const chosen = question.choices.filter((choice) => selected.has(choice));
      answers.push({ ...(chosen.length > 0 ? { choices: chosen } : {}), ...typedPart });
      continue;
    }

    if (answer.choice !== undefined) {
      if (typeof answer.choice !== "string" || !question.choices.includes(answer.choice)) return null;
      answers.push({ choice: answer.choice, ...typedPart });
      continue;
    }
    if (freeText === undefined) return null;
    answers.push(typedPart);
  }

  return { requestId: request.id, answers };
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
     * 1–4 questions to ask in a single composer-dock card. Anything outside that
     * range is rejected up-front so the renderer never has to defend
     * against malformed multi-question shapes.
     */
    questions: AskUserQuestionItem[];
    /** Conversation the asking turn belongs to; routes the card to its tile. */
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<AskUserQuestionResponse> {
    if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > MAX_QUESTIONS_PER_CARD) {
      return Promise.resolve({
        requestId: "",
        dismissed: true,
      });
    }
    const normalizedQuestions = input.questions.map(normalizeQuestion);
    if (normalizedQuestions.some((question) => question === null)) {
      return Promise.resolve({ requestId: "", dismissed: true });
    }
    const req: AskUserQuestionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      questions: normalizedQuestions as AskUserQuestionItem[],
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
      this.pending.set(req.id, { request: req, resolve, cleanup });
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

  resolve(response: AskUserQuestionResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (!entry) return false;
    const normalized = normalizeResponse(entry.request, response);
    if (!normalized) return false;
    entry.cleanup();
    entry.resolve(normalized);
    return true;
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
