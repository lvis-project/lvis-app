/**
 * Which share is this?
 *
 * An armed Away Authority grant is a statement about one particular share: the
 * owner looked at a paired account and a shared conversation and said "answer
 * for the next few minutes". A revoke, re-share, pause, disconnect or re-pair
 * replaces that share with a different one, and the grant must not survive it.
 *
 * The per-call authority re-check inside {@link ApprovalGate} cannot enforce
 * that on its own. A re-pair mints a FRESH authority whose guard answers
 * `isCurrent` perfectly well; nothing about the call is stale. Only the grant is
 * stale, and only something watching the share itself can tell.
 *
 * The obvious way to watch it — subscribe to the connection store, which funnels
 * every mutation through one `emitChange` — is right about the chokepoint and
 * wrong about the signal. "The document changed" is not "the share changed". The
 * store's document also holds the poll offset, which advances after **every
 * inbound message**: `telegram-bridge-server` calls `recordPollOffset` once
 * per handled update, that goes through `mutate`, and `mutate` emits whenever
 * the document changed. Retiring on the raw signal therefore retires the grant
 * on the very traffic the feature exists to answer — and because
 * `handleWebhook` returns as soon as the turn is admitted rather than awaiting
 * it, the offset write lands before the turn's first approval reaches the gate.
 * The grant would answer nothing at all.
 *
 * So this module keeps the chokepoint and narrows the signal: it memoizes the
 * tuple that NAMES the share and reports only a difference.
 */
import { canonicalStringify } from "../shared/canonical-json.js";
import type { TelegramOwnerConnectionSnapshot } from "./telegram-connection-store.js";

/**
 * A store that cannot be read is not a share this process can vouch for, so it
 * gets its own identity value and any transition into or out of it counts as a
 * change. Fail-safe: the cost is a grant the owner re-arms, and the alternative
 * is a grant that outlives the state that justified it.
 */
const UNREADABLE_SHARE = "unreadable";

/**
 * The tuple that names WHICH share this is.
 *
 * Included, and what each one catches:
 *
 * - `desiredState` — pause, resume, disconnect.
 * - `activationEpoch` — connect and disconnect bump it, so a reconnection cycle
 *   is a new activation even when it lands on the same values.
 * - `botFingerprint` — a different bot makes every stored digest meaningless.
 * - `pairing` id and account fingerprint — revoke and re-pair.
 * - `approval` id and conversation digest — revoke, re-share, and a share that
 *   expired out from under the grant.
 *
 * Deliberately excluded, because a share does not change when they do:
 *
 * - The poll offset — it is not on the owner snapshot at all, which is the
 *   point: reading the owner projection rather than the raw document is what
 *   makes inbound traffic invisible here.
 * - `lastErrorCode` — a provider hiccup is not a lifecycle event. This is also
 *   why the identity is built from the owner snapshot rather than the service's
 *   derived `TelegramConnectionState`: `deriveState` folds a non-null
 *   `lastErrorCode` into `"error"`, so a transient unreachable-provider note
 *   would read as a share change through that projection.
 * - `pendingCode` — a minted, unredeemed pairing code is not a share. It becomes
 *   one only on redemption, which changes the pairing id.
 * - `pairingUnrecognized` — it is derived from the pairing record's state, and
 *   when it flips the pairing summary goes null, which this tuple already sees.
 *
 * `canonicalStringify` rather than a delimiter join: every field is
 * length-delimited by the encoder, so no value can impersonate another by
 * containing the separator.
 */
function telegramShareIdentity(
  owner: TelegramOwnerConnectionSnapshot,
): string {
  return canonicalStringify({
    desiredState: owner.desiredState,
    activationEpoch: owner.activationEpoch,
    botFingerprint: owner.botFingerprint,
    pairingId: owner.pairing?.id ?? null,
    pairingAccount: owner.pairing?.accountFingerprint ?? null,
    approvalId: owner.approval?.id ?? null,
    approvalConversation: owner.approval?.conversationDigest ?? null,
  });
}

/**
 * Build a store-change subscriber that reports only share-identity changes.
 *
 * The first identity is read at construction, so the first change the returned
 * subscriber sees is compared against a real baseline rather than counting as a
 * change by itself. Construction happens at boot, long before anything can be
 * armed, so an early transition (a stored connection resuming, say) costs
 * nothing.
 */
export function createTelegramShareChangeWatcher(options: {
  readonly readOwnerSnapshot: () => TelegramOwnerConnectionSnapshot;
  readonly onShareChanged: () => void;
}): () => void {
  const read = (): string => {
    try {
      return telegramShareIdentity(options.readOwnerSnapshot());
    } catch {
      return UNREADABLE_SHARE;
    }
  };
  let last = read();
  return () => {
    const current = read();
    if (current === last) return;
    last = current;
    options.onShareChanged();
  };
}
