import type { ParentAdjudicationEscalationCause } from "../permissions/parent-adjudicator.js";

/**
 * Why the sub-agent approval chain reached the user after tier 2 ran.
 *
 * Every cause the adjudicator itself can answer with, plus one the gate owns:
 * the module answers one call at a time and cannot see that it is answering the
 * same call for the third time, so the repetition cause can only be raised in
 * the gate, where the counter lives.
 */
export type ParentEscalationCause =
  | ParentAdjudicationEscalationCause
  /**
   * The parent denied this child's use of this tool once too often. The chain
   * escalates rather than denying again, because a child looping against a
   * denial is exactly the state the parent cannot resolve on its own.
   */
  | "repeated-denial";

/**
 * The dock's account of a tier-2 stage that ended with the user.
 *
 * It lives in `shared/` rather than beside the gate for the same reason
 * {@link ./permission-review-status.js} does: the renderer needs the shape, and
 * the alternative is a renderer module importing the approval gate — a file
 * that owns the session key and the HMAC check — for a type.
 */
export interface ParentEscalationNotice {
  cause: ParentEscalationCause;
  /**
   * One sentence, sanitized, DLP-masked and length-bounded where the parent's
   * answer is parsed (`permissions/parent-adjudicator.ts`), which is the only
   * place a result of that shape is minted. That bound is the only one: a
   * second cut at the dock would silently drop the end of a sentence whose
   * point is usually at the end.
   */
  reason: string;
  /**
   * Which child run raised the escalated ask.
   *
   * Host-TRANSPORTED, not host-authored: it comes from the run registry, but
   * the registry got it from the `title` argument the parent model wrote when
   * it spawned the child. It is therefore masked and display-normalized before
   * it is put here, and the dock quotes it rather than narrating it — the same
   * treatment {@link reason} gets, for the same reason.
   */
  childTitle: string;
}
