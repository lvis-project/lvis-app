/**
 * Remote tool-approval cards for the paired Telegram surface.
 *
 * One coordinator owns the whole feature: which parked approvals may be
 * offered remotely (a single policy chokepoint), the opaque token→approval
 * mapping behind every inline-keyboard button, and the one handler a verified
 * button press reaches. The decision itself is NOT made here — a press is
 * relayed into the same `ApprovalGate.resolve` chokepoint the desktop dock's
 * IPC handler calls, under the same nonce/HMAC integrity and allowed-choice
 * checks, so there is no second resolution path to audit.
 *
 * Wire-safety contract, same as every other Telegram module: the card carries
 * only the coarse shared tool identifier and fixed host text — never
 * arguments, paths, reasons, or verdicts — and `callback_data` is an opaque
 * random token that maps to a pending approval only inside this process.
 * Nothing here logs a chat id, a message id, message text, or provider error
 * detail.
 */
import { randomBytes } from "node:crypto";
import {
  isHostApprovalTimeoutDecision,
  type ApprovalDecision,
  type PendingApprovalObserver,
  type PendingApprovalView,
} from "../permissions/approval-gate.js";
import { isSharedApprovalToolIdentifier } from "../shared/permission-review-status.js";
import type {
  TelegramBotApiClient,
  TelegramDecisionButton,
} from "./telegram-bot-api-client.js";
import type { TelegramCallbackQueryEnvelope } from "./telegram-platform-adapter.js";

/**
 * Active cards at once. An approval wait is a blocking, sequential state, so
 * more than a handful of live cards means something is wrong upstream; the
 * bound keeps a pathological producer from turning the bridge into a card
 * flood.
 */
const MAX_ACTIVE_CARDS = 8;

/** 128-bit random token, base64url: 22 chars, inside the opaque grammar. */
const CALLBACK_TOKEN_BYTES = 16;

/**
 * Fixed host sentences, in the same deliberately unlocalized register as the
 * adapter's `OUTBOUND_STATUS_TEXT`. The tool identifier interpolated below is
 * validated against the one shared grammar before it may appear.
 */
const CARD_TEXT = Object.freeze({
  prompt: (tool: string) =>
    `LVIS: tool ${tool} is waiting for approval. This decides this run only.`,
  approved: (tool: string) => `LVIS: tool ${tool} approved for this run`,
  denied: (tool: string) => `LVIS: tool ${tool} denied`,
  expired: (tool: string) => `LVIS: the approval for tool ${tool} is no longer active`,
  approveButton: "Approve once",
  denyButton: "Deny",
  ackApproved: "Approved for this run",
  ackDenied: "Denied",
  ackStale: "This approval is no longer active",
});

/**
 * The narrow slice of the approval gate this feature is allowed to touch:
 * observe what is parked, and answer through the one shared resolve
 * chokepoint as the `"platform-bridge"` answerer.
 */
export interface TelegramRemoteApprovalGatePort {
  observePendingApprovals(observer: PendingApprovalObserver): () => void;
  resolve(
    requestId: string,
    decision: ApprovalDecision,
    answeredBy: "platform-bridge",
  ): ApprovalDecision | null;
}

export interface TelegramRemoteApprovalCoordinator {
  /** The one entry for a verified inline-keyboard press from the poller. */
  handleCallbackQuery(callback: TelegramCallbackQueryEnvelope): Promise<void>;
  /** Detach from the gate and best-effort invalidate cards still showing buttons. */
  dispose(): void;
}

export interface CreateTelegramRemoteApprovalCoordinatorOptions {
  readonly client: Pick<
    TelegramBotApiClient,
    "sendDecisionCard" | "editMessageText" | "answerCallbackQuery"
  >;
  readonly gate: TelegramRemoteApprovalGatePort;
  /**
   * The egress fence, re-checked per card: the chat id of the CURRENT route
   * bound to this conversation, or null when the approval's conversation is
   * not the paired, shared, on-screen one. Null means no card is sent at all.
   */
  readonly routeChatIdForConversation: (conversationId: string) => string | null;
  /**
   * Same trust derivation as message inbound: the sender id digests to the
   * currently paired owner. A press failing this is acknowledged (to clear the
   * client spinner) and otherwise ignored without any distinguishable reply.
   */
  readonly isPairedOwner: (senderId: string) => boolean;
  readonly log?: (message: string) => void;
}

/**
 * What the single remote-approval policy offers for one parked approval, or
 * null for "not remotely decidable".
 */
interface RemoteApprovalOffer {
  readonly conversationId: string;
  readonly toolIdentifier: string;
  /** The ONLY choices a remote press can produce. */
  readonly approveChoice: "allow-once";
  readonly denyChoice: "deny-once";
}

/**
 * THE policy chokepoint for remote approval. Every widening of what a phone
 * may decide — more request kinds, more scopes — is an edit to this function
 * and nowhere else.
 *
 * Scope is deliberately one-shot only: the offer's choices are the literal
 * `allow-once`/`deny-once`, so an `allow-session` or `allow-always` cannot be
 * expressed by a remote press even if a forged token reached the handler —
 * and the gate's own allowed-choice check backstops this on resolve.
 */
function remoteApprovalOffer(view: PendingApprovalView): RemoteApprovalOffer | null {
  // Only an ordinary tool ask. Directory-scope grants, plugin agent actions,
  // and rationale cards are desk-only decisions.
  if (view.category !== "tool") return null;
  if (view.kind !== undefined && view.kind !== "tool") return null;
  // An approval with no conversation attribution cannot be fenced to the
  // shared conversation, so it is not offered.
  if (view.sessionId === undefined) return null;
  // Requests that constrain their answers must accept both one-shot choices.
  if (
    view.allowedChoices !== undefined
    && (!view.allowedChoices.includes("allow-once")
      || !view.allowedChoices.includes("deny-once"))
  ) {
    return null;
  }
  const toolIdentifier = view.source === undefined
    ? view.toolName
    : `${view.source}:${view.toolName}`;
  // Fail closed: a name outside the shared grammar never reaches the wire.
  if (!isSharedApprovalToolIdentifier(toolIdentifier)) return null;
  return {
    conversationId: view.sessionId,
    toolIdentifier,
    approveChoice: "allow-once",
    denyChoice: "deny-once",
  };
}

interface RemoteApprovalCard {
  readonly requestId: string;
  readonly toolIdentifier: string;
  readonly chatId: string;
  /** Echo material for the shared resolve chokepoint; never leaves the host. */
  readonly echoNonce: string;
  readonly echoHmac: string;
  readonly approveToken: string;
  readonly denyToken: string;
  /** Learned from the send result; edits are impossible before it arrives. */
  messageId?: number;
  /** Set at settlement; applied as soon as a message id exists. */
  finalText?: string;
}

export function createTelegramRemoteApprovalCoordinator(
  options: CreateTelegramRemoteApprovalCoordinatorOptions,
): TelegramRemoteApprovalCoordinator {
  if (
    !options
    || typeof options.client?.sendDecisionCard !== "function"
    || typeof options.client?.editMessageText !== "function"
    || typeof options.client?.answerCallbackQuery !== "function"
    || typeof options.gate?.observePendingApprovals !== "function"
    || typeof options.gate?.resolve !== "function"
    || typeof options.routeChatIdForConversation !== "function"
    || typeof options.isPairedOwner !== "function"
  ) {
    throw new TypeError("telegram-remote-approval-options-invalid");
  }
  const { client, gate, log } = options;
  const cardsByRequest = new Map<string, RemoteApprovalCard>();
  const cardsByToken = new Map<string, { card: RemoteApprovalCard; choice: "allow-once" | "deny-once" }>();
  let disposed = false;

  const editCard = (card: RemoteApprovalCard): void => {
    if (card.messageId === undefined || card.finalText === undefined) return;
    void client
      .editMessageText(card.chatId, card.messageId, card.finalText)
      .then((result) => {
        if (!result.ok) log?.("[telegram-remote-approval] card edit failed");
      })
      .catch(() => {
        log?.("[telegram-remote-approval] card edit failed");
      });
  };

  const retireCard = (card: RemoteApprovalCard, finalText: string): void => {
    cardsByRequest.delete(card.requestId);
    cardsByToken.delete(card.approveToken);
    cardsByToken.delete(card.denyToken);
    card.finalText = finalText;
    editCard(card);
  };

  const finalTextFor = (card: RemoteApprovalCard, decision: ApprovalDecision): string => {
    // Read before the guard: its `decision is ApprovalDecision` predicate
    // would otherwise narrow the negated branch to `never`.
    const approved = decision.choice.startsWith("allow");
    if (isHostApprovalTimeoutDecision(decision)) return CARD_TEXT.expired(card.toolIdentifier);
    return approved
      ? CARD_TEXT.approved(card.toolIdentifier)
      : CARD_TEXT.denied(card.toolIdentifier);
  };

  const observer: PendingApprovalObserver = {
    onPending: (view) => {
      if (disposed) return;
      const offer = remoteApprovalOffer(view);
      if (offer === null) return;
      let chatId: string | null;
      try {
        chatId = options.routeChatIdForConversation(offer.conversationId);
      } catch {
        return;
      }
      if (chatId === null) return;
      if (cardsByRequest.size >= MAX_ACTIVE_CARDS || cardsByRequest.has(view.requestId)) {
        log?.("[telegram-remote-approval] card skipped: active card bound reached");
        return;
      }
      const card: RemoteApprovalCard = {
        requestId: view.requestId,
        toolIdentifier: offer.toolIdentifier,
        chatId,
        echoNonce: view.nonce,
        echoHmac: view.hmac,
        approveToken: randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url"),
        denyToken: randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url"),
      };
      cardsByRequest.set(card.requestId, card);
      cardsByToken.set(card.approveToken, { card, choice: offer.approveChoice });
      cardsByToken.set(card.denyToken, { card, choice: offer.denyChoice });
      const buttons: readonly TelegramDecisionButton[] = [
        { label: CARD_TEXT.approveButton, callbackData: card.approveToken },
        { label: CARD_TEXT.denyButton, callbackData: card.denyToken },
      ];
      void client
        .sendDecisionCard(card.chatId, CARD_TEXT.prompt(card.toolIdentifier), buttons)
        .then((result) => {
          if (!result.ok) {
            // An unsent card must not keep live tokens: a press can only
            // arrive for a card that exists on the owner's screen.
            cardsByRequest.delete(card.requestId);
            cardsByToken.delete(card.approveToken);
            cardsByToken.delete(card.denyToken);
            log?.("[telegram-remote-approval] card send failed");
            return;
          }
          card.messageId = result.value.messageId;
          // Settled while the send was in flight: apply the final edit now.
          editCard(card);
        })
        .catch(() => {
          cardsByRequest.delete(card.requestId);
          cardsByToken.delete(card.approveToken);
          cardsByToken.delete(card.denyToken);
          log?.("[telegram-remote-approval] card send failed");
        });
    },
    onSettled: (requestId, decision) => {
      const card = cardsByRequest.get(requestId);
      if (card === undefined) return;
      retireCard(card, finalTextFor(card, decision));
    },
  };
  const unsubscribe = gate.observePendingApprovals(observer);

  const acknowledge = async (callbackQueryId: string, text?: string): Promise<void> => {
    try {
      const result = await client.answerCallbackQuery(callbackQueryId, text);
      if (!result.ok) log?.("[telegram-remote-approval] callback acknowledgement failed");
    } catch {
      log?.("[telegram-remote-approval] callback acknowledgement failed");
    }
  };

  return Object.freeze({
    async handleCallbackQuery(callback: TelegramCallbackQueryEnvelope): Promise<void> {
      // A press from anyone but the paired owner is acknowledged — the
      // client spinner must clear — and otherwise ignored, with no text: a
      // reply would confirm to a stranger that this bot fronts a live
      // desktop. Same silence whether the token is real or not, so a
      // stranger cannot probe which tokens exist.
      let paired: boolean;
      try {
        paired = options.isPairedOwner(callback.senderId);
      } catch {
        paired = false;
      }
      if (disposed || !paired) {
        await acknowledge(callback.callbackQueryId);
        return;
      }
      const binding = cardsByToken.get(callback.data);
      if (binding === undefined) {
        // Expired, already decided, or never minted: all one answer, so a
        // late press after a local decision stays harmless and indistinct.
        await acknowledge(callback.callbackQueryId, CARD_TEXT.ackStale);
        return;
      }
      // The SAME resolve chokepoint the desktop dock's IPC handler calls,
      // with the gate's own echo material. Integrity, allowed-choice, and
      // audit all happen in the gate; settlement re-enters this module only
      // through the observer above, which edits the card.
      const decision = gate.resolve(
        binding.card.requestId,
        {
          requestId: binding.card.requestId,
          choice: binding.choice,
          nonce: binding.card.echoNonce,
          hmac: binding.card.echoHmac,
        },
        "platform-bridge",
      );
      if (decision === null) {
        // Raced by a local decision between lookup and resolve.
        await acknowledge(callback.callbackQueryId, CARD_TEXT.ackStale);
        return;
      }
      await acknowledge(
        callback.callbackQueryId,
        decision.choice.startsWith("allow") ? CARD_TEXT.ackApproved : CARD_TEXT.ackDenied,
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // Buttons that can no longer reach a handler must not keep looking
      // pressable. Best-effort and not awaited: teardown never blocks on a
      // provider.
      for (const card of [...cardsByRequest.values()]) {
        retireCard(card, CARD_TEXT.expired(card.toolIdentifier));
      }
    },
  });
}
