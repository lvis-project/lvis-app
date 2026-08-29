/**
 * Away Authority — the desk-armed second answerer for approvals raised by a
 * paired external-platform turn.
 *
 * ## What this is, and what it deliberately is not
 *
 * The problem it solves: the owner is away from the desk, a paired platform
 * turn raises an approval, and nobody is there to answer it. The approval
 * blocks until it times out and denies.
 *
 * The obvious fix — forward the prompt to the phone and let the owner tap
 * "allow" — does not survive review. Nothing on an inbound chat-platform path
 * authenticates a message: sender identity is a self-reported field inside JSON
 * the host itself fetched, so the provider, any bot-token holder, and any
 * OS-trusted MITM CA can author an "allow". Relaying the request's nonce/HMAC
 * would be worse: that pair signs the REQUEST, never the CHOICE, so putting it
 * on a third-party transport converts a confused-deputy defence into a bearer
 * token. And the prompt could not carry enough to decide on — tool inputs and
 * local paths must not leave the machine, so the remote prompt degrades to
 * "approve fs_write?", which is a rubber stamp.
 *
 * This module is the replacement. The authorization is a LOCAL desk gesture,
 * made in advance at the owner's own trusted surface, that says: "for the next
 * N minutes, in this conversation, answer read/write asks under these
 * directories, up to M of them, and nothing else." The remote side gains no new
 * answer surface at all — no inbound message is read here, and no inbound
 * message can create, extend, or widen a grant.
 *
 * ## Why it is not a bypass
 *
 * It runs INSIDE {@link ApprovalGate.requestAndWait}, below every hard gate:
 * rationale-display validation, execution-plan issuance, host-shell binding
 * match, plan mismatch, the sensitive-path hard block, and the destroyed-window
 * deny all precede it and are unreachable from here. It leaves the
 * permission-manager remote-controller branch untouched, so a remote turn still
 * cannot inherit a remembered allow. It answers exactly one call at a time with
 * `allow-once` and audits every one. The implementations that WOULD be
 * bypasses — an allow rule, an `alwaysAllowed` entry, a permission-manager
 * branch, or a remote memory-skip lane — all sit below or outside the gate.
 *
 * ## Retirement
 *
 * A grant dies on desk disarm, on expiry, on budget exhaustion, on any share
 * lifecycle change (revoke, re-share, pause, disconnect, re-pair), and on
 * process restart. The last one is free: this module holds the grant in memory
 * and writes nothing durable, on purpose. The share-lifecycle case is enforced
 * twice for two different reasons, not as layered defence: the per-call
 * authority re-check refuses a call whose own authority has gone stale, while
 * {@link AwayAuthority.retireAll} at the lifecycle chokepoint retires the GRANT
 * — which the per-call check cannot do, because a re-pair mints a fresh,
 * perfectly current authority that the earlier desk gesture never authorized.
 */
import type { ToolCategory } from "../tools/types.js";
import type {
  RemoteControllerAuthority,
  RemoteControllerOrigin,
} from "../shared/chat-origin.js";
import {
  isRemoteControllerAuthorityCurrent,
  remoteControllerOriginOf,
} from "../shared/chat-origin.js";
import type { ApprovalChoice, ApprovalKind } from "./approval-gate.js";
import {
  isPathAllowed,
  sanitizeAllowedDirectories,
} from "./allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "./sensitive-paths.js";
import type { ToolSource } from "../shared/permission-review-status.js";

/**
 * The only tool categories a desk gesture may arm, as a compile-checked subset
 * of {@link ToolCategory}. `Extract` rather than a re-declared union: the
 * category set has one owner, and a rename there must break this line rather
 * than leave an armable literal that no longer names anything.
 *
 * The excluded categories, each for its own reason:
 *
 * - `network` — an armed read plus an armed network call is arbitrary
 *   exfiltration: read the secret, POST it out, both auto-answered.
 * - `shell` — a shell command is not a category, it is every category at once;
 *   nothing about the request bounds what it will do.
 * - `meta` — meta tools create or continue execution outside the turn that was
 *   armed for (agent spawn, permission-mode change). A grant that can widen the
 *   permission mode is a grant that can remove itself as a constraint.
 */
type AwayAuthorityCategory = Extract<ToolCategory, "read" | "write">;

/**
 * TOTAL record over the armable categories, so widening
 * {@link AwayAuthorityCategory} fails to compile until the new member is
 * declared here too. This is the runtime membership test; there is no second
 * list of these literals anywhere.
 */
const ARMABLE_CATEGORIES: Record<AwayAuthorityCategory, true> = {
  read: true,
  write: true,
};

function isArmableCategory(value: unknown): value is AwayAuthorityCategory {
  return typeof value === "string"
    && Object.hasOwn(ARMABLE_CATEGORIES, value);
}

/**
 * Longest a single desk gesture may leave the answerer armed. A grant is a
 * statement about how long the owner expects to be away, not a mode; there is
 * no unbounded option because "until I turn it off" is exactly the grant nobody
 * remembers to turn off.
 */
const MAX_TTL_MS = 4 * 60 * 60 * 1000;

/** Most calls one arming may answer before it retires itself. */
const MAX_BUDGET = 50;

/** What the desk asks for. Every field is validated before it becomes a grant. */
export interface AwayAuthorityArmInput {
  /** The conversation the desk armed for; asks from any other are refused. */
  readonly conversationId: string;
  readonly categories: readonly string[];
  /** Raw directory scope; sanitized to the Layer 1 canonical form. */
  readonly directories: readonly string[];
  readonly ttlMs: number;
  readonly budget: number;
}

/** A validated, frozen grant. Only {@link parseAwayAuthorityGrant} mints one. */
export interface AwayAuthorityGrant {
  readonly conversationId: string;
  readonly categories: readonly AwayAuthorityCategory[];
  /** Canonicalized + case-folded, ready for {@link isPathAllowed}. */
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly budget: number;
}

/**
 * The request fields the answerer reads. Assembled by the gate from the
 * approval request and from host-only state; never from a message, a renderer
 * payload, or provider output.
 *
 * `source` is the request's own field, kept optional on purpose so this module
 * can apply a STRICT `=== "builtin"` test. `ApprovalGate.getRequestSnapshot`
 * defaults a missing `source` to the high-trust `"builtin"` for approval-cache
 * identity, which is conservative there and wrong here: an absent field would
 * pass as builtin.
 */
export interface AwayAuthorityCandidate {
  /** Host-set audit marker for the controller behind the asking turn. */
  readonly remoteControllerOrigin: RemoteControllerOrigin | undefined;
  /** The live authority object; the only non-forgeable evidence of the turn. */
  readonly remoteControllerAuthority: RemoteControllerAuthority | undefined;
  readonly sessionId: string | undefined;
  readonly source: ToolSource | undefined;
  readonly kind: ApprovalKind | undefined;
  readonly category: "tool" | "agent-action";
  readonly toolCategory: ToolCategory | undefined;
  readonly allowedChoices: readonly ApprovalChoice[] | undefined;
  /** The gate's DERIVED capability, not the caller's requested value. */
  readonly durableApprovalRecordAllowed: boolean;
  /** Whether a host-shell one-shot permit binding rides with this request. */
  readonly hostShellExecutionPermitBound: boolean;
  /**
   * EVERY path this call would touch, not just the one the modal displays.
   *
   * Plural because binding the first path alone is not a bound: `move_file`
   * declares `["sourcePath", "destinationPath"]`, so an in-scope source would
   * carry an out-of-scope destination past a singular check.
   *
   * An empty list is a call that names no path at all, which is refused rather
   * than waved through — see {@link AwayAuthority.targetScopeRefusal}.
   */
  readonly targetFilePaths: readonly string[];
}

/**
 * Why a call was not away-answered. A closed union: the value reaches an audit
 * row, and audit rows are space-delimited `key=value` pairs, so nothing that
 * could carry caller text may be written there.
 */
type AwayAuthorityRefusal =
  | "not-armed"
  | "expired"
  | "not-platform-bridge"
  | "authority-not-current"
  | "conversation-mismatch"
  | "not-builtin-source"
  | "not-tool-request"
  | "category-not-armed"
  | "not-one-shot-contract"
  | "durable-record-allowed"
  | "host-shell-permit-bound"
  | "target-unresolved"
  | "target-out-of-scope";

export type AwayAuthorityEvaluation =
  | {
      readonly answer: true;
      /**
       * Budget left AFTER this answer. `0` means the grant has just retired
       * itself, which is the only moment exhaustion can be reported: once
       * retired there is no grant left to explain why it stopped answering.
       */
      readonly remaining: number;
    }
  | {
      readonly answer: false;
      readonly refusal: AwayAuthorityRefusal;
      /**
       * Whether this refusal is a fact about an armed grant rather than about
       * an ordinary desk approval that was never the answerer's business.
       *
       * The gate audits only reportable refusals. Without this, either every
       * desk approval in the app would write an "away declined" row, or an
       * exhausted grant would silently let a remote turn block until timeout
       * with nothing in the log explaining why. The distinction is decided here
       * because this is where the reason is known.
       */
      readonly reportable: boolean;
    };

/** The refusal half of {@link AwayAuthorityEvaluation}, named so the internal
 * "why not, or null" helpers can return exactly it without re-declaring the
 * shape. */
type AwayAuthorityRefusalOutcome = Extract<
  AwayAuthorityEvaluation,
  { answer: false }
>;

function refuse(
  refusal: AwayAuthorityRefusal,
  reportable: boolean,
): AwayAuthorityRefusalOutcome {
  return { answer: false, refusal, reportable };
}

/**
 * Validate a desk arming request into a grant, or return `null`.
 *
 * Every bound is enforced here so no other code has to re-check one. A grant
 * that survives this function is safe for {@link AwayAuthority} to hold: its
 * categories are armable, its directories are Layer 1 canonical and free of
 * sensitive paths (via {@link sanitizeAllowedDirectories}), and its lifetime
 * and budget are finite.
 *
 * A `write` grant with an empty directory scope is refused rather than
 * normalized to "anywhere": {@link isPathAllowed} already denies on an empty
 * scope, so such a grant could only ever refuse, and an armed-looking grant
 * that can never answer is a worse outcome than a failed arming the desk can
 * see and correct.
 */
export function parseAwayAuthorityGrant(
  input: AwayAuthorityArmInput,
  now: number,
): AwayAuthorityGrant | null {
  if (!input || typeof input !== "object") return null;
  if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
    return null;
  }
  if (!Array.isArray(input.categories) || input.categories.length === 0) return null;
  if (!input.categories.every(isArmableCategory)) return null;
  const categories = [...new Set(input.categories)];
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_TTL_MS) {
    return null;
  }
  if (
    !Number.isInteger(input.budget)
    || input.budget <= 0
    || input.budget > MAX_BUDGET
  ) {
    return null;
  }
  if (!Array.isArray(input.directories)) return null;
  const directories = sanitizeAllowedDirectories(input.directories);
  // A rejected entry means the desk asked to arm something the Layer 1
  // sanitizer refuses (a sensitive path, a filesystem root). Arm nothing rather
  // than arm the surviving subset: a partially honoured scope is a scope the
  // owner did not agree to.
  if (directories.length !== input.directories.length) return null;
  if (categories.includes("write") && directories.length === 0) return null;
  return Object.freeze({
    conversationId: input.conversationId,
    categories: Object.freeze(categories),
    directories: Object.freeze(directories),
    expiresAt: now + input.ttlMs,
    budget: input.budget,
  });
}

/** Read-only view of an armed grant, for surfaces that display its state. */
export interface AwayAuthoritySnapshot {
  readonly conversationId: string;
  readonly categories: readonly AwayAuthorityCategory[];
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly remaining: number;
}

/**
 * Holds at most one grant and decides every away answer.
 *
 * In-memory by design: a grant is a statement about the next few minutes, and
 * a process restart is a change in circumstances the owner did not authorize
 * through. Nothing here touches the filesystem.
 */
export class AwayAuthority {
  private grant: AwayAuthorityGrant | null = null;
  private remaining = 0;

  /** Replace any current grant with a validated one. */
  arm(grant: AwayAuthorityGrant): void {
    this.grant = grant;
    this.remaining = grant.budget;
  }

  /**
   * Retire everything, whatever the reason: desk disarm, expiry, budget
   * exhaustion, and — the case the per-call authority re-check cannot cover —
   * the share lifecycle chokepoint, because a revoke/re-share/pause/
   * disconnect/re-pair mints a NEW authority that is perfectly current and that
   * the earlier desk gesture never saw.
   */
  retireAll(): boolean {
    const had = this.grant !== null;
    this.grant = null;
    this.remaining = 0;
    return had;
  }

  snapshot(): AwayAuthoritySnapshot | null {
    const grant = this.grant;
    if (grant === null) return null;
    return Object.freeze({
      conversationId: grant.conversationId,
      categories: grant.categories,
      directories: grant.directories,
      expiresAt: grant.expiresAt,
      remaining: this.remaining,
    });
  }

  /**
   * Decide a call and, when the answer is yes, spend one unit of budget.
   *
   * The single mutating entry point: there is no way to get an affirmative
   * answer without the budget moving, so a caller cannot evaluate repeatedly
   * and act on a stale yes.
   */
  consume(candidate: AwayAuthorityCandidate, now: number): AwayAuthorityEvaluation {
    const refusal = this.refusalFor(candidate, now);
    if (refusal !== null) return refusal;
    const remaining = this.remaining - 1;
    this.remaining = remaining;
    // Spent means gone, in the same step that spent it. Leaving a zero-budget
    // grant armed would mean a state that looks armed and can never answer,
    // and it is the reason there is no "budget exhausted" refusal: after this
    // line there is no grant for such a refusal to be about.
    if (remaining <= 0) this.retireAll();
    return { answer: true, remaining };
  }

  /** Why this call may not be away-answered, or `null` when it may. */
  private refusalFor(
    candidate: AwayAuthorityCandidate,
    now: number,
  ): AwayAuthorityRefusalOutcome | null {
    const grant = this.grant;
    // Not armed, or not a paired-platform turn: this is an ordinary approval
    // that was never the answerer's business, so its refusal is not reportable.
    if (grant === null) return refuse("not-armed", false);

    // Origin comes from the authority object, which the conversation command
    // port mints and which is the only non-forgeable evidence a remote
    // controller is behind the turn. The host-set marker on the request must
    // agree, because that marker is what the audit row will state: the answerer
    // refuses to act on evidence that disagrees with the row it is about to
    // write. Tailnet turns are excluded here by not being `platform-bridge` —
    // a native controller session is a live operator at a keyboard, a different
    // situation from an away owner, and it keeps its own local one-shot rule.
    const authorityOrigin = remoteControllerOriginOf(
      candidate.remoteControllerAuthority,
    );
    if (
      authorityOrigin !== "platform-bridge"
      || candidate.remoteControllerOrigin !== authorityOrigin
    ) {
      return refuse("not-platform-bridge", false);
    }

    // Everything below is reportable: an armed grant received a paired-platform
    // ask, so why it did or did not answer is part of this grant's record.

    if (now >= grant.expiresAt) {
      this.retireAll();
      return refuse("expired", true);
    }

    // Re-checked HERE, not at request time. A share revoked while the turn was
    // in flight must not be answered by a grant that was valid when the turn
    // started.
    if (!isRemoteControllerAuthorityCurrent(candidate.remoteControllerAuthority)) {
      return refuse("authority-not-current", true);
    }

    if (
      candidate.sessionId === undefined
      || candidate.sessionId !== grant.conversationId
    ) {
      return refuse("conversation-mismatch", true);
    }

    // STRICT field test. Plugin and MCP tools are excluded by it: a third-party
    // tool's declared category is not an authority boundary, so a plugin "read"
    // is not evidence the call only reads. See the type comment for why
    // `getRequestSnapshot` must not be used to answer this question.
    if (candidate.source !== "builtin") return refuse("not-builtin-source", true);

    // `undefined` or `"tool"` only. This is what excludes the remaining
    // non-tool approval surfaces:
    //   - `out-of-allowed-dir` — a directory-scope grant. Widening the scope
    //     the grant itself is bounded by is the one thing it may never do.
    //   - `rationale` — a card whose entire purpose is that a human reads an
    //     explanation before deciding. Nobody is reading.
    //   - `agent-action` — a plugin-origin host request, not a host tool call;
    //     `category` catches the same class from the other side.
    // MCP elicitations are renderer-only structured-content prompts that the
    // desk fills in; they never reach an away answer, and `source` refuses them
    // regardless.
    if (candidate.kind !== undefined && candidate.kind !== "tool") {
      return refuse("not-tool-request", true);
    }
    if (candidate.category !== "tool") return refuse("not-tool-request", true);

    if (
      candidate.toolCategory === undefined
      || !isArmableCategory(candidate.toolCategory)
      || !grant.categories.includes(candidate.toolCategory)
    ) {
      return refuse("category-not-armed", true);
    }

    // Exactly the two-member one-shot contract. This is the request-shape half
    // of "can never mint a durable record": the gate's `resolve` path rejects
    // any choice outside `allowedChoices`, and an away answer is issued as
    // `allow-once` and returns before a pending entry is ever created.
    const choices = candidate.allowedChoices;
    if (
      choices === undefined
      || choices.length !== 2
      || !choices.includes("allow-once")
      || !choices.includes("deny-once")
    ) {
      return refuse("not-one-shot-contract", true);
    }
    // The state half of the same rule, read from the gate's DERIVED value. The
    // one-shot contract above already forces this false today, so this line is
    // an invariant assertion rather than an independently reachable branch —
    // it is what makes a future change to that derivation fail closed here
    // instead of quietly handing the answerer a durable-record capability.
    if (candidate.durableApprovalRecordAllowed) {
      return refuse("durable-record-allowed", true);
    }

    // A host-shell one-shot permit binding must never be minted by an away
    // answer. The category check above already excludes it today, because the
    // gate only retains a binding whose request is `toolCategory === "shell"`
    // and shell is not armable. This check is what keeps that true if either
    // of those two facts ever changes.
    if (candidate.hostShellExecutionPermitBound) {
      return refuse("host-shell-permit-bound", true);
    }

    return this.targetScopeRefusal(grant, candidate);
  }

  /**
   * Directory scope.
   *
   * A `write` must name a path that resolves inside the armed directories: a
   * write with no resolvable target is a write whose scope cannot be checked,
   * and an unbounded write is exactly what the grant is not.
   *
   * A `read` is held to exactly the same rule, and an earlier version of this
   * module was wrong about that. It waved through a read that named no path,
   * reasoning that a read leaving the allowed directories would arrive as
   * `kind === "out-of-allowed-dir"` and be refused above. That reasoning holds
   * only for tools that touch the filesystem. A tool that touches no path has
   * no directory scope to leave, so nothing refused it and nothing bounded it —
   * and `web_fetch` is `category: "read"`, escalating to `network` only for
   * private-network hosts. A read-only grant therefore auto-approved arbitrary
   * public egress: read the secret from an armed directory, then post it out,
   * both answered. That is the exact chain the `network` exclusion above is
   * documented as preventing.
   *
   * So the rule is one rule: a call is in scope only if it names at least one
   * path and EVERY path it names resolves inside the armed directories. What
   * the grant authorizes is file work in named folders, and a call that is not
   * file work in a named folder is not a smaller version of that — it is
   * something else, and it waits for the desk.
   */
  private targetScopeRefusal(
    grant: AwayAuthorityGrant,
    candidate: AwayAuthorityCandidate,
  ): AwayAuthorityRefusalOutcome | null {
    const raw = candidate.targetFilePaths;
    if (raw.length === 0) return refuse("target-unresolved", true);
    for (const path of raw) {
      if (typeof path !== "string" || path.length === 0) {
        return refuse("target-unresolved", true);
      }
      let folded: string;
      try {
        folded = caseFoldForMatch(canonicalizePathForMatch(path));
      } catch {
        return refuse("target-unresolved", true);
      }
      if (!isPathAllowed(folded, { directories: grant.directories })) {
        return refuse("target-out-of-scope", true);
      }
    }
    return null;
  }
}
