/**
 * Parent → child mid-run directive: the envelope, the bounds, the outcomes.
 *
 * A parent could already reach a SUSPENDED child by resuming it
 * (`agent_spawn(resumeId)`), and a child could already reach its parent or a
 * sibling (`agent_send`). The missing edge was the parent telling a child that
 * is ALREADY RUNNING to change direction or stop — the parent had to interrupt
 * the child and start over, losing the run.
 *
 * The directive travels as ordinary round-boundary guidance on the child's own
 * loop (running child) or as a durable mailbox entry the resume path drains
 * (suspended child). Both consume text shaped HERE, so the child sees one
 * grammar whichever door the message came through.
 *
 * WHY THE FENCE. The parent is an LLM, and its directive is text it composed —
 * frequently text it read somewhere. The label saying "your parent said this"
 * is host-composed and lives OUTSIDE the fence; the parent's own words sit
 * inside it, quoted as data, with their closing tag neutralized so a body
 * cannot end the fence and continue as if the host were still speaking. This
 * is the same grammar `wrapChildReportForParentJudgment` uses in the other
 * direction, and the same fence discipline as every staged origin.
 */
import { t } from "../i18n/index.js";
import { neutralizeFenceClose, type FenceTag } from "../shared/fence-sanitizer.js";

/** Registered in `fence-sanitizer.ts`; the tag is a host constant, never caller text. */
export const PARENT_DIRECTIVE_FENCE_TAG: FenceTag = "lvis-parent-directive";

/**
 * Bound on the parent-authored body.
 *
 * Half of `GUIDE_MAX_CHARS`, which is the bound the child's guidance queue
 * enforces on the FORMATTED text: the host label is a few hundred characters in
 * every locale, so a body within this bound can never produce an envelope the
 * queue would reject. A directive is an instruction, not a document.
 */
export const PARENT_DIRECTIVE_MAX_CHARS = 4_000;

/**
 * How many undelivered directives one child may hold.
 *
 * Deliberately small and per-child: a parent that keeps sending into a child it
 * never resumes would otherwise grow the durable store without bound, and a
 * child woken with sixteen stale directives cannot act on any of them coherently.
 * Reaching the cap is reported to the parent rather than silently rotating, so
 * "I already told it four things it has not read" is visible.
 */
export const PARENT_DIRECTIVE_MAX_PENDING = 4;

export type ParentDirectiveDropReason =
  /** No such sub-agent session, or the ids are malformed. */
  | "unknown-recipient"
  /** The child exists but belongs to a different parent session. */
  | "cross-origin"
  /** A session cannot direct itself. */
  | "self-send"
  /** Only a root session may direct a child: no hop beyond parent → own child. */
  | "nested-parent"
  | "invalid-message"
  | "message-too-long"
  /** The child's run already finished; there is nothing left to direct. */
  | "terminal-recipient"
  /** Not running and not resumable — the directive could never be delivered. */
  | "child-not-resumable"
  /** Running, but not accepting guidance at this instant. Retryable. */
  | "recipient-unavailable"
  | "pending-cap"
  | "storage-failed"
  | "mailbox-unavailable";

export type ParentDirectiveDeliveryResult =
  | {
      ok: true;
      /**
       * `queued` — handed to the running child's guidance queue; it lands at the
       * child's next round boundary. `mailbox` — the child is suspended and the
       * directive waits durably for the parent to resume it.
       */
      disposition: "queued" | "mailbox";
      childSessionId: string;
      messageId: string;
    }
  | { ok: false; reason: ParentDirectiveDropReason };

/** C0 controls (tab and newline excepted) never belong in a directive body. */
export function hasUnsafeDirectiveControlChars(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/**
 * Wrap a DLP-masked, parent-authored directive in its host label and fence.
 *
 * The caller masks and bounds the body first; this function owns only the
 * framing, so the exact bytes a running child receives and the bytes a resumed
 * child receives are produced by one expression.
 */
export function formatParentDirective(maskedText: string): string {
  const body = neutralizeFenceClose(maskedText, PARENT_DIRECTIVE_FENCE_TAG);
  return [
    t("be_parentDirective.hostInstruction"),
    "",
    `<${PARENT_DIRECTIVE_FENCE_TAG}>`,
    body,
    `</${PARENT_DIRECTIVE_FENCE_TAG}>`,
  ].join("\n");
}
