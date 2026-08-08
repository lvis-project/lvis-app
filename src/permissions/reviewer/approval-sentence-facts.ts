/**
 * The sealed projection of a pending approval that the `/allow` selector is
 * allowed to see.
 *
 * Issue #1940. The selector call is **reasoning-blind**: it carries the user's
 * own sentence plus these four facts and nothing else. It does not carry the
 * agent's rationale for the call, the tool's arguments, the tool's output, the
 * reviewer's verdict, or any prior assistant turn.
 *
 * That matters because the text an attacker controls and the text that decides
 * an approval must not be the same text. A tool result, a file the agent just
 * read, or a plugin's description can all end up describing themselves as
 * urgent and pre-approved. If any of that reached this envelope, injected
 * content would be shaping the approval of the very call that produced it.
 * Here the only free text is what the user typed.
 *
 * The record is assembled FIELD BY FIELD, never by spreading the pending
 * entry. A spread would mean the next field someone adds to that entry
 * silently becomes model-visible — a disclosure decision nobody made, in a
 * diff that does not mention this file. Adding a field here has to be typed
 * out, which is the point.
 */

/**
 * Exactly what the selector sees about the request. Closed by construction.
 *
 * A type alias rather than an interface so it satisfies the selector's
 * `Readonly<Record<string, unknown>>` envelope parameter without an index
 * signature — an index signature would defeat the point, since it would let
 * any extra key through the type system on its way to the model.
 */
export type ApprovalRequestFacts = {
  toolName: string;
  category: string;
  source: string;
  candidatePath: string;
};

export interface ApprovalSentenceFactsInput {
  toolName: string;
  toolCategory: string | undefined;
  source: string;
  candidatePath: string;
}

export function buildApprovalRequestFacts(
  input: ApprovalSentenceFactsInput,
): ApprovalRequestFacts {
  // Field by field. Do not replace with a spread.
  return {
    toolName: input.toolName,
    category: input.toolCategory ?? "unknown",
    source: input.source,
    candidatePath: input.candidatePath,
  };
}
