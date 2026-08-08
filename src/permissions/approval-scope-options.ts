/**
 * The scopes an out-of-allowed-dir approval is willing to grant — one
 * authority, shared by the card that renders them and the host that offers
 * them to the `/allow` sentence selector.
 *
 * Issue #1940. Both consumers must agree on the *same* list, in the *same*
 * order: the selector returns an option and the renderer has to land on the
 * button that option means. Two copies of this derivation would pass their own
 * unit tests and disagree only at the integration — so there is exactly one.
 *
 * Nothing here reads the filesystem or the user's sentence. `candidatePath`
 * and `suggestedParent` arrive already host-resolved (`pickClosestParent`),
 * and a scope's `path` is only ever one of those two values.
 */
import type { ApprovalChoice } from "./approval-gate.js";

export interface ApprovalScopeOption {
  /**
   * Opaque, positional handle. It is the only thing besides `choice` that is
   * ever disclosed to the selector model, and it carries no path.
   */
  id: string;
  choice: ApprovalChoice;
  /** Widening scopes outlive the call being decided. */
  widens: boolean;
  /** Host-resolved path this scope would allow. Never user-supplied. */
  path?: string;
}

export interface ApprovalScopeInput {
  candidatePath: string;
  suggestedParent: string | null;
  /** Host-imposed narrowing (e.g. a remote-controller one-shot request). */
  allowedChoices?: readonly ApprovalChoice[];
}

/**
 * Build the scope list, narrowest first. Order is part of the contract: the
 * card focuses index 0, and a widening scope is always something the user
 * moved to on purpose.
 */
export function buildApprovalScopeOptions(
  input: ApprovalScopeInput,
): ApprovalScopeOption[] {
  const { candidatePath, suggestedParent, allowedChoices } = input;
  const permitted = (c: ApprovalChoice) => !allowedChoices || allowedChoices.includes(c);
  const out: ApprovalScopeOption[] = [];
  const push = (option: Omit<ApprovalScopeOption, "id">) => {
    out.push({ id: `o${out.length + 1}`, ...option });
  };

  if (permitted("allow-once")) {
    push({ choice: "allow-once", widens: false, path: candidatePath });
  }
  if (suggestedParent && permitted("allow-session")) {
    push({ choice: "allow-session", widens: true, path: candidatePath });
  }
  if (suggestedParent && permitted("allow-always")) {
    push({ choice: "allow-always", widens: true, path: suggestedParent });
  }
  // Deny is a peer scope, so refusing costs what allowing costs.
  if (permitted("deny-once")) push({ choice: "deny-once", widens: false });
  return out;
}
