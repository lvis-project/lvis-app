/**
 * Recurring Layer-1 denial tracker — the counter behind the headless
 * out-of-allowed-dir escalation.
 *
 * ## The problem
 *
 * Layer 1 (`additionalDirectories`) is evaluated independently of the category
 * axis, and it stays that way: `allow` mode covers categories, never
 * directories. A path outside the allowed roots is refused on its own axis.
 *
 * On the interactive lane that refusal already ASKS — the executor raises the
 * `out-of-allowed-dir` approval and the user picks a scope. On the HEADLESS
 * lane (a plugin-emitted `ctx.callTool` chain, `headless: true`) there is no
 * modal: the call is denied, a deferred-queue entry is written, and the caller
 * gets a tool error. A caller that retries gets the same error forever, and the
 * user watching the chat sees the same failure repeat with no way to answer it.
 *
 * ## What this module does, and what it deliberately does not
 *
 * It counts how many times the SAME denial has been produced, and says once —
 * at {@link LAYER1_DENIAL_ESCALATION_THRESHOLD} — "stop failing silently, ask".
 * It does not grant anything, it does not widen a scope, and it does not decide
 * what the ask looks like. The caller takes its `escalate` answer and routes the
 * request into the EXISTING interactive directory-grant path with the existing
 * scope choices; the user's answer there is the only thing that authorizes a
 * widening. A declined or unanswered escalation falls back to the ordinary deny.
 *
 * ## Why the identity is what it is
 *
 * The counter's identity is `(session scope, grant subject, canonical refused
 * path)`.
 *
 *  - `sessionId` — the executor-supplied session scope the denial happened in.
 *    On the main conversation lane that IS the conversation. On the plugin
 *    surface it is the synthetic per-lane id `pluginInvocationSessionId` builds
 *    (`plugin-<origin>-<caller-or-owner>`), which is stable for the process
 *    rather than per-chat. Either reading is safe here because this component
 *    can only ever SPLIT counters that would otherwise merge, so including it
 *    can only reduce the number of asks. An absent `sessionId` is untrackable
 *    and never escalates.
 *  - `grantSubject` — WHO would receive the grant. This is the same subject
 *    `createPluginSurfacePermissionScope` already keys its session-grant map
 *    with (`pluginPermissionGrantSubject`: owner plugin, else caller plugin,
 *    else host). Making the counter's subject identical to the grant sink's
 *    subject is the anti-farming property: N denials spread across N plugins
 *    are N counters against N different sinks and can never sum to one ask.
 *    An absent subject is untrackable and never escalates.
 *
 *    Note the deliberate asymmetry with the scope above:
 *    `pluginInvocationSessionId` prefers the CALLER plugin while
 *    `pluginPermissionGrantSubject` prefers the OWNER. For a wrapper (plugin B
 *    calling plugin A's tool) that makes the counter strictly NARROWER than the
 *    sink — two callers of A hold separate counters that both drain into A's
 *    store. Narrower is the safe direction: it takes more distinct evidence to
 *    earn one ask than the resulting grant's own granularity, and where the
 *    grant lands is pre-existing behaviour this module does not change.
 *  - `canonicalPath` — the exact path that was refused, already canonicalized
 *    and case-folded by the caller. NOT the parent directory the escalation
 *    would offer to add: keying on the offered parent would let refusals of
 *    three unrelated files under one root accumulate into a single ask for that
 *    whole root, which is strictly more authority than the recurrence
 *    evidences.
 *
 * The tool name and the tool category are deliberately absent. A directory
 * grant names a subject and a directory; it does not name a tool, and it is not
 * scoped by category — Layer 1 and the category axis are separate by design.
 * Putting either in the key would make the counter identify something other
 * than the grant it is evidence for.
 *
 * ## Why it cannot be used to nag a user into granting
 *
 * This module hands the headless lane a capability it did not have — the
 * ability to put a modal in front of the user — so it is bounded twice.
 *
 * An identity escalates AT MOST ONCE. `recordDenial` marks it the moment it
 * returns `escalate: true`, so a caller that is refused cannot come back for a
 * second, third, or hundredth prompt by failing three more times. After the
 * single ask, the identity is back to the ordinary deny permanently.
 *
 * And a session scope raises at most
 * {@link LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE} escalations in total, because
 * "one ask per identity" alone still lets a caller cycle through distinct paths
 * to raise one modal after another. The per-identity rule bounds repetition;
 * this one bounds variety. A caller that spends the budget goes back to the
 * ordinary deny for everything, forever.
 *
 * The user always has the explicit `/permission dir allow` and the Permissions
 * tab if they change their mind — those are the paths for a deliberate grant,
 * and this one is only for interrupting a silent loop.
 *
 * In-memory by design, like every other short-lived permission state here:
 * a process restart forgets the counts, which can only ever mean fewer asks.
 */

/**
 * How many times the same denial must recur before the user is asked.
 *
 * Three, because it is the smallest number that distinguishes a loop from an
 * accident. One denial is the normal, correct outcome of a call that should not
 * have been made and carries no evidence of anything. Two is still ordinary:
 * a caller retrying once after a failure is the single most common shape of
 * retry logic and of model behaviour, so escalating at two would turn every
 * one-shot retry into a permission prompt. By the third identical refusal the
 * caller is not recovering from a transient failure — it is asking for
 * something it structurally needs and cannot get, which is the only situation
 * where interrupting the user is better than failing again.
 *
 * Raising it further buys nothing: the fourth and fifth identical denials carry
 * no information the third did not, and each one is another failure the user
 * watched go by without being offered a way to answer it.
 */
export const LAYER1_DENIAL_ESCALATION_THRESHOLD = 3;

/**
 * Ceiling on how many distinct identities one tracker will follow at a time.
 *
 * When the ceiling is reached, identities that are not already tracked are not
 * tracked at all and therefore never escalate. That is the fail-closed
 * direction: a caller that floods the tracker with distinct paths buys itself
 * fewer prompts, not more, and the ordinary deny is unaffected throughout.
 * Eviction is not used — an evicted identity would silently restart at zero,
 * which is the same fail-closed outcome with a less predictable rule.
 */
export const LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT = 512;

/**
 * Most escalations one session scope may raise, for the tracker's whole life.
 *
 * "One ask per identity" bounds a caller repeating itself, but not a caller
 * varying itself: three calls each on a hundred different paths are a hundred
 * distinct identities and, without this, a hundred modals. A stuck caller is
 * normally stuck on one place, so a handful of asks is all a legitimate one
 * ever needs; past that the honest reading is not "it needs another directory"
 * but "the user has been asked enough".
 *
 * Deliberately per scope rather than per tracker: the plugin surface runs every
 * plugin through one executor, so a single global budget would let one noisy
 * plugin spend the budget a different plugin legitimately needed. The map this
 * counts in cannot outgrow {@link LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT}, since
 * only a scope with a tracked identity can ever reach it.
 */
export const LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE = 3;

/** The three fields that decide whether two denials are "the same denial". */
export interface Layer1DenialIdentity {
  /**
   * Session scope the denial happened in — the conversation on the main lane,
   * a stable per-lane id on the plugin surface (see the module doc).
   * `undefined` is untrackable.
   */
  readonly sessionId: string | undefined;
  /**
   * Subject that would receive a grant — the value
   * `pluginPermissionGrantSubject` produces for the surface that asked.
   * `undefined` is untrackable.
   */
  readonly grantSubject: string | undefined;
  /** Canonicalized, case-folded path that Layer 1 refused. */
  readonly canonicalPath: string;
}

export type Layer1DenialRecord =
  /**
   * This denial has no usable identity (no session scope, no grant subject, no
   * path) or the tracker is at its identity ceiling. It is counted nowhere and
   * can never escalate.
   */
  | { readonly tracked: false }
  | {
      readonly tracked: true;
      /** Denials recorded for this identity, including the current one. */
      readonly count: number;
      /**
       * `true` on at most ONE call per identity: the call that reached
       * {@link LAYER1_DENIAL_ESCALATION_THRESHOLD} while its session scope
       * still had escalation budget left. Reading it is what spends it.
       */
      readonly escalate: boolean;
    };

/** The one untrackable answer, shared so the branches below cannot drift. */
const UNTRACKED: Layer1DenialRecord = Object.freeze({ tracked: false as const });

/**
 * Encode an identity as a map key. `JSON.stringify` of the tuple rather than a
 * delimiter join: a filesystem path may contain any character a delimiter could
 * use, and two identities that collide would merge two callers' counters.
 */
function identityKey(
  sessionId: string,
  grantSubject: string,
  canonicalPath: string,
): string {
  return JSON.stringify([sessionId, grantSubject, canonicalPath]);
}

/**
 * Counts recurring Layer-1 denials and decides the single escalation moment.
 *
 * One instance per `ToolExecutor`, held for the executor's lifetime. The plugin
 * surface runs EVERY plugin through a single executor, which is exactly why the
 * subject is part of the identity rather than implied by the instance.
 */
export class Layer1DenialRecurrenceTracker {
  private readonly counts = new Map<string, number>();
  private readonly escalated = new Set<string>();
  /** Escalations already raised per session scope, against the budget. */
  private readonly escalationsByScope = new Map<string, number>();

  /**
   * Record one denial and answer whether it is the escalation moment.
   *
   * The single mutating entry point, and it both counts and spends: there is no
   * way to observe `escalate: true` without the identity being marked as having
   * escalated, so a caller cannot evaluate twice and act on a stale yes.
   */
  recordDenial(identity: Layer1DenialIdentity): Layer1DenialRecord {
    const { sessionId, grantSubject, canonicalPath } = identity;
    if (
      typeof sessionId !== "string" || sessionId.length === 0
      || typeof grantSubject !== "string" || grantSubject.length === 0
      || typeof canonicalPath !== "string" || canonicalPath.length === 0
    ) {
      return UNTRACKED;
    }
    const key = identityKey(sessionId, grantSubject, canonicalPath);
    const previous = this.counts.get(key);
    if (previous === undefined && this.counts.size >= LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT) {
      return UNTRACKED;
    }
    const count = (previous ?? 0) + 1;
    this.counts.set(key, count);
    if (count < LAYER1_DENIAL_ESCALATION_THRESHOLD || this.escalated.has(key)) {
      return { tracked: true, count, escalate: false };
    }
    // Budget checked last, and NOT recorded as an escalation for this identity:
    // the identity earned its ask and was refused one for a reason that has
    // nothing to do with it. Spending is monotonic, so it will keep being
    // refused — the distinction only keeps `escalated` meaning exactly "has
    // already put a modal in front of the user".
    const raised = this.escalationsByScope.get(sessionId) ?? 0;
    if (raised >= LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE) {
      return { tracked: true, count, escalate: false };
    }
    this.escalationsByScope.set(sessionId, raised + 1);
    this.escalated.add(key);
    return { tracked: true, count, escalate: true };
  }
}
