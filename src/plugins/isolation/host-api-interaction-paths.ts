/**
 * The members that put something in front of the USER, or decide whether an
 * action is permitted (`docs/blueprints/plugin-process-isolation.md` §3).
 *
 * Seven of the 36: `openExternalUrl`, `openAuthWindow`,
 * `openAuthPartitionViewer`, `clearAuthPartition`, `triggerConversation`, and
 * the `agentApproval` pair. They are grouped because their failure modes differ
 * from a data read in one specific way:
 *
 *   A REFUSAL IS AN ANSWER. `agentApproval.request` resolves `"deny-once"`;
 *   `triggerConversation` resolves `{ accepted: false, reason }`. Both are
 *   values the plugin is expected to branch on, and neither is an error.
 *   A call that could not be DELIVERED — the gate threw, the window service is
 *   gone, the incarnation is retired — must therefore reject, never resolve
 *   with a refusal the user never gave. Collapsing the two would let a broken
 *   host read as a user who said no, and nothing downstream could tell.
 *
 * WHY THESE HANDLERS CALL `hostApi` AND VALIDATE NOTHING THEMSELVES. Every one
 * of these members already validates its own arguments host-side, and that
 * validation IS the security decision: `openExternalUrl` runs `validateExternalUrl`
 * and the webView-preference routing, `openAuthWindow` enforces the
 * `external-auth-consumer` capability and the per-plugin partition allow-list,
 * `clearAuthPartition` enforces the same partition rule, `triggerConversation`
 * runs the overlay gate, and `agentApproval.*` verifies the issuer registry and
 * the approved scope grant. A boundary check in front of any of them would be a
 * SECOND, weaker copy of a rule that lives somewhere else — the exact drift
 * §3.6 warns about. The boundary's own obligations are the ones the dispatcher
 * already discharges for every path: the envelope, the generation, the JSON
 * gate on arguments and results.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach the
 * plugin's own `hostApi` — the instance the effect recorder and the effect gate
 * have already wrapped for THIS plugin incarnation. `HostApiCall` carries
 * identity and arguments, not host state, so the binding can only be a closure.
 * The dispatcher composes the bound entries over `HOSTAPI_DISPATCH_TABLE` with
 * object spread, which is the mechanism its own tests already use.
 *
 * HOST-SIDE ONLY. `host-api-dispatcher.ts` reaches Electron through the
 * approval gate; the child's half of these members is
 * `host-api-interaction-child.ts`, which imports neither.
 */
import type {
  ApprovalChoice,
  ConversationTriggerSpec,
  PluginHostApi,
} from "../public-contract.js";
import {
  defineHostApiPath,
  type HostApiPathHandler,
} from "./host-api-dispatcher.js";
import type { InteractionHostApiPath } from "./host-api-interaction-child.js";

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type InteractionHostApi = Pick<
  PluginHostApi,
  | "openExternalUrl"
  | "openAuthWindow"
  | "openAuthPartitionViewer"
  | "clearAuthPartition"
  | "triggerConversation"
  | "agentApproval"
>;

/**
 * `openAuthWindow` is TWO overloads over ONE implementation, and which applies
 * is decided by `returnFinalUrl` inside the host — `AuthWindowCookie[]` for the
 * cookie form, `{ cookies, finalUrl }` for the other. Both are plain JSON, so
 * the boundary carries whichever the host produced. Picking the branch here
 * would put a second copy of that decision on the wire, where it could disagree
 * with the host's.
 */
type OverloadedOpenAuthWindow = (options: unknown) => Promise<unknown>;

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createInteractionHostApiPaths(
  hostApi: InteractionHostApi,
): Record<InteractionHostApiPath, HostApiPathHandler> {
  // The four `void`-declared members RETURN the host's promise rather than
  // awaiting and discarding it. Discarding would also discard a host that
  // started resolving a value, and the dispatcher's void check — the one thing
  // that catches the child's stub and the host's implementation disagreeing
  // about a member — would never see it. A drift is refused, not absorbed.
  return {
    // The host decides in-app window vs system browser from the live webView
    // preference and rejects a non-http(s) scheme; the child learns only that
    // it resolved, or which error it was.
    openExternalUrl: defineHostApiPath("openExternalUrl", (call) =>
      hostApi.openExternalUrl(call.args[0] as string),
    ),
    openAuthWindow: defineHostApiPath("openAuthWindow", async (call) => {
      const openAuthWindow = hostApi.openAuthWindow as unknown as OverloadedOpenAuthWindow;
      // `.call` keeps the receiver, because the instance handed here may be a
      // recorder/gate wrapper whose members are not free functions.
      return await openAuthWindow.call(hostApi, call.args[0]);
    }),
    openAuthPartitionViewer: defineHostApiPath("openAuthPartitionViewer", (call) =>
      hostApi.openAuthPartitionViewer(
        call.args[0] as { url: string; windowTitle?: string },
      ),
    ),
    clearAuthPartition: defineHostApiPath("clearAuthPartition", (call) =>
      hostApi.clearAuthPartition(call.args[0] as string),
    ),
    // `{ accepted: false, reason }` is a RESULT, not an error — the plugin is
    // documented to branch on `accepted`. A throw from here means the trigger
    // never reached the overlay at all.
    triggerConversation: defineHostApiPath("triggerConversation", async (call) =>
      hostApi.triggerConversation(call.args[0] as ConversationTriggerSpec),
    ),
    // Blocks on a human, for as long as the human takes. The boundary imposes
    // no call timeout of its own precisely so it cannot abandon a gate entry
    // that is still pending in the host (§7.5) — the gate's own timeout is the
    // only deadline, and it resolves `deny-once` as a VALUE.
    "agentApproval.request": defineHostApiPath(
      "agentApproval.request",
      async (call) =>
        hostApi.agentApproval.request(
          call.args[0] as {
            toolName: string;
            args: unknown;
            reason: string;
            scope: string;
          },
        ),
    ),
    // Four positional arguments, the last two optional. `nonce` and `hmac` are
    // gate-issued strings echoed back verbatim; they survive JSON unchanged,
    // which is what lets the gate's confused-deputy check still work from a
    // different process.
    "agentApproval.respond": defineHostApiPath("agentApproval.respond", (call) =>
      hostApi.agentApproval.respond(
        call.args[0] as string,
        call.args[1] as ApprovalChoice,
        call.args[2] as string | undefined,
        call.args[3] as string | undefined,
      ),
    ),
  };
}
