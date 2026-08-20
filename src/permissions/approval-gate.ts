import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebContents } from "electron";
import { t } from "../i18n/index.js";
import type { PolicyFile } from "./policy-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { ToolCategory } from "../tools/types.js";
import type { RiskLevel, RiskVerdict } from "./reviewer/risk-classifier.js";
import type {
  ParentAdjudicationEvidence,
  ParentAdjudicationOptions,
  ParentAdjudicationResult,
  ParentAdjudicator,
} from "./parent-adjudicator.js";
import type { ParentContextTurn } from "./parent-context-evidence.js";
import type {
  ParentAdjudicationModelSource,
  ReviewerParentAdjudicationBlock,
} from "./permission-settings-store.js";
import type { DeferredQueue } from "./reviewer/deferred-queue.js";
import {
  resolveReviewerSandboxCapability,
  type SandboxCapability,
} from "./sandbox-capability.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import {
  isSensitivePath,
  canonicalizePathForMatch,
} from "./sensitive-paths.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { displaySafeLabel } from "../shared/display-safe-text.js";
import type {
  ParentEscalationNotice,
} from "../shared/parent-escalation-notice.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { resolveUserApprovalVerdict } from "../shared/permissions-events.js";
import type {
  RemoteControllerAuthority,
  RemoteControllerOrigin,
} from "../shared/chat-origin.js";
import {
  AwayAuthority,
  parseAwayAuthorityGrant,
  type AwayAuthorityArmInput,
  type AwayAuthorityCandidate,
  type AwayAuthoritySnapshot,
} from "./away-authority.js";
import {
  parseRationaleApprovalDisplay,
  type RationaleApprovalDisplay,
  sealMaskedRationaleApprovalDisplay,
} from "../shared/rationale-approval-display.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";
import { parseHostShellExecutionInput } from "./host-shell-execution-input.js";
import {
  type HostShellExecutionPermitBinding,
} from "./host-shell-execution-permit.js";
import {
  getHostShellExecutionPlanAuditProjection,
  isIssuedHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlanAuditProjection,
} from "./host-shell-execution-plan.js";

// ─── Args DLP masking ────────────────────────────────

function maskArgsForDisplay(value: unknown, detections: Set<string>): unknown {
  if (typeof value === "string") {
    const { masked, detections: hits } = maskSensitiveData(value);
    for (const h of hits) detections.add(h);
    return masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v, detections));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v, detections);
    }
    return out;
  }
  return value;
}

function maskApprovalPurposeForDisplay(
  purpose: ApprovalPurposeSuggestion,
  detections: Set<string>,
): ApprovalPurposeSuggestion {
  const { masked, detections: hits } = maskSensitiveData(purpose.text);
  for (const hit of hits) detections.add(hit);
  return { ...purpose, text: masked };
}

// ─── Tier-2 (parent adjudication) constants ──────────

/** Verdict order, for the ceiling the host enforces before asking a parent. */
const RISK_LEVEL_RANK: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Consecutive parent denials of the same tool by the same child before the ask
 * goes to the user instead.
 *
 * A child that keeps reaching for a tool its parent keeps refusing is in a loop
 * neither of them can end: the parent has already given its answer, and the
 * child is not persuaded by it. The user is the only party who can resolve
 * that, so the third denial is escalated rather than answered again.
 */
const PARENT_DENIAL_ESCALATION_THRESHOLD = 3;

/**
 * Denial counters retained at once. Bounded for the reason the adjudicator's
 * budget map is: child runs end without telling the gate. Eviction is
 * least-recently-used, so it can only reset a streak for a child that has been
 * idle behind this many others.
 */
const MAX_TRACKED_PARENT_DENIAL_KEYS = 1_000;

/** Longest parent reason written to an audit row. */
const MAX_AUDIT_REASON_CHARS = 160;

/**
 * Longest serialized argument payload shown to an adjudicating parent.
 *
 * The dock's copy of the arguments crosses local IPC, so its size was never
 * anyone's problem. This copy crosses the network to a paid provider, once per
 * ask, up to the per-run budget — and the adjudicator answers one ask at a
 * time, so a child writing megabytes into a tool argument would bill the user
 * for them and stall every other child's ask behind them.
 */
const MAX_EVIDENCE_ARGS_CHARS = 4_000;

/**
 * Bound the argument payload before it leaves the host.
 *
 * Truncation is safe in exactly one direction, and this is that direction:
 * evidence a parent cannot see is evidence it cannot approve on, so a truncated
 * payload can only move the answer toward escalate — which is the user.
 *
 * Bounding happens BEFORE masking, not after. DLP masking walks every string in
 * the structure with a battery of patterns, and on a multi-megabyte tool
 * argument that walk costs minutes on this process's only thread — so a bound
 * applied to the masking OUTPUT would have prevented the network cost and kept
 * the stall. The preview is masked like everything else: it is the input to the
 * masking pass, never its output.
 */
function boundedEvidenceArgs(args: unknown): unknown {
  let serialized: string;
  try {
    serialized = canonicalStringify(args);
  } catch {
    // Unserializable arguments are not evidence. Say so rather than guess.
    return { omitted: "arguments could not be rendered" };
  }
  if (serialized.length <= MAX_EVIDENCE_ARGS_CHARS) return args;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_EVIDENCE_ARGS_CHARS),
  };
}

/**
 * Render model-authored text for an audit row.
 *
 * Rows are space-delimited `key=value` pairs, so a value containing a space and
 * an `=` can forge the fields after it — a parent reason reading
 * `... choice=allow-always` would otherwise write a lie into the record that
 * exists to catch exactly that. Whitespace and `=` are the two characters that
 * make the forgery, so both become `_`; the text stays readable and can no
 * longer be parsed as more than one field.
 *
 * Applied to the host-owned child session id too, though nothing model-authored
 * reaches it. The rule this file already follows for the answerer and origin
 * tokens is that a value is made safe at the boundary where it enters a durable
 * record, not at whichever earlier point someone argued it could not be hostile.
 */
function auditSafeText(value: string): string {
  return value
    .slice(0, MAX_AUDIT_REASON_CHARS)
    .replace(/[\s=]+/g, "_");
}

/**
 * Permission mode hint passed alongside an ApprovalRequest. Drives the
 * §S4 isReadOnly short-circuit: in "ask_all" and "plan" modes even
 * read-only tools must still show the approval dock.
 *
 * `undefined` → treat as "default" (standard read-only auto-approve).
 */
export type ApprovalMode = "default" | "ask_all" | "plan" | "full_auto";

/**
 * Permission policy P2.5 — discriminated kinds for the approval dock.
 * Default `"tool"` is the normal §6.3 Layer 3 ask;
 * `"out-of-allowed-dir"` is the Layer 1 directory-confirm variant; and
 * `"agent-action"` is a plugin-origin host approval request that does
 * not correspond to a host tool execution.
 */
export type ApprovalKind =
  "tool" | "out-of-allowed-dir" | "agent-action" | "rationale";

export interface ApprovalRequest {
  id: string;
  category: "tool" | "agent-action";
  /**
   * Permission policy P2.5 — discriminator for the renderer to pick the right card.
   * Defaults to `"tool"` when omitted (backwards-compatible).
   */
  kind?: ApprovalKind;
  /** Choices the host will accept for this request. */
  allowedChoices?: readonly ApprovalChoice[];
  toolName: string;
  /** Permission policy category for the invocation shown in the UI. */
  toolCategory?: ToolCategory;
  /** Layer 5 reviewer verdict when the ask came from auto-review. */
  reviewerVerdict?: RiskVerdict;
  /** Single captured tool-call evaluation context shown to the user. */
  evaluationContext?: PermissionEvaluationContext;
  /** Suggested natural-language purpose shown in the approval dock. */
  approvalPurpose?: ApprovalPurposeSuggestion;
  /**
   * Present iff tier 2 ran for this ask and handed the decision back to the
   * user. It is the dock's only account of a stage the user never saw, and
   * without it a parent-escalated ask is indistinguishable from one that was
   * never eligible for a parent at all.
   *
   * Host-composed and outbound-only: the host writes it after the parent
   * answers, the renderer displays it, and no decision field echoes it back.
   * It is deliberately NOT part of the {@link signApprovalRequest} preimage —
   * that signature authenticates the renderer round trip, and a field with no
   * echoed copy has nothing to authenticate (see that function for the same
   * argument applied to `remoteControllerOrigin`).
   */
  parentEscalation?: ParentEscalationNotice;
  args: unknown;
  reason: string;
  /**
   * Host-composed label naming the cross-agent message that was influencing
   * the caller when this ask was raised (`[Sub-Agent: <title>]`), when one
   * was. The same string is already the leading segment of {@link reason},
   * so carrying it structurally discloses nothing new — it just stops the
   * consumers that need the FACT from having to parse it back out of prose.
   *
   * Host-composed and outbound-only, for the reason {@link parentEscalation}
   * is: the host writes it, no decision field echoes it back, and it is not
   * part of the {@link signApprovalRequest} preimage.
   */
  approvalReasonPrefix?: string;
  source?: "builtin" | "plugin" | "mcp";
  /** Plugin id that issued this approval request, when source === "plugin". */
  sourcePluginId?: string;
  /** Manifest-declared plugin approval scope for agent-action requests. */
  approvalScope?: string;
  createdAt: number;

  requireExplicit: boolean;
  /**
   * Permission policy P2.5 — Layer 1 directory-confirm payload. Present iff
   * `kind === "out-of-allowed-dir"`. Carries the candidate parent path
   * + adjacency warnings so the renderer can render the auto-suggest
   * UI without re-running validation.
   */
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
    currentAllowed: readonly string[];
    adjacencyWarnings: readonly string[];
  };
  /**
   * Permission policy P2.5 §9 — trust origin classification
   * (user-keyboard / plugin-emitted / app-emitted / llm-tool-arg / file-content).
   * Audited; renderer may surface badge.
   */
  trustOrigin?: string;
  /**
   * Issue #691 — OS-level execution sandbox SOT,
   * surfaced to the approval dock so the user can see whether the
   * tool will run under the ASRT OS sandbox (macOS Seatbelt / Linux bwrap)
   * or with no isolation. Captured at request build time by the executor
   * (and by {@link ApprovalGate} for non-tool approvals) from
   * {@link detectSandboxCapability}; immutable thereafter.
   *
   * Typed as the canonical
   * {@link SandboxCapability} (not a structural mirror) to keep the
   * `platform: NodeJS.Platform` enum tight. Mirror declarations in the
   * renderer type SHOULD use the same shape.
   */
  sandboxCapability?: SandboxCapability;
  /**
   * Renderer-safe, allowlist-only execution substrate snapshot for a host shell
   * action. It intentionally contains no command, CWD, directory scope,
   * approval binding, permit, nonce, or HMAC material.
   */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /**
   * §S1: absolute filesystem path the tool intends to touch. When set and
   * matched against SENSITIVE_PATH_PATTERNS, the request is hard-blocked
   * BEFORE the user approval surface is shown. Cannot be overridden.
   */
  target?: {
    filePath?: string;
  };
  /**
   * §S4: tool self-declares it does not mutate state. When true and the
   * current mode is not "plan", the approval dock is skipped and the call is
   * auto-approved with reason "read-only auto-approve".
   */
  isReadOnly?: boolean;
  /**
   * §S4: current permission mode. Drives the isReadOnly short-circuit:
   *   - "default" / "full_auto" / undefined → read-only tools auto-approve
   *   - "ask_all" / "plan" → still show the approval dock
   */
  mode?: ApprovalMode;
  /**
   * §S1 metadata hint. When the executor detected that `target.filePath`
   * matches a SENSITIVE_PATH_PATTERNS entry, this field carries the
   * matched pattern string for diagnostics, logging, and any non-blocking
   * consumers of the request payload. Remains `null`/omitted when the
   * path is not sensitive.
   *
   * Note: the authoritative hard-block is enforced inside
   * {@link ApprovalGate.requestAndWait} before any approval dock is
   * shown, using the same {@link isSensitivePath} function. As a result,
   * the renderer should not rely on this field to display blocked-state UI
   * for the sensitive-path denial path.
   */
  sensitivePathPattern?: string | null;
  /**
   * Cache key for approval record/lookup symmetry.
   * Propagated from executor's approvalCacheKeyFor() result so the
   * renderer can record and look up entries using the same key that
   * dispatchReviewer uses. Without this field the renderer receives
   * undefined and the record key mismatches the lookup key → approval
   * cache hit rate 0% for tools like routine_schedule / bash / fs_write.
   */
  approvalCacheKey?: string;
  /**
   * Host-owned attribution: the conversation (session) whose turn raised this
   * approval. Side chats and sub-agents block on approval docks while the
   * user is looking at a different conversation, so the dock and the audit
   * trail both need to name the asking conversation.
   *
   * It is set by the host tool path from the session id it already carries;
   * it is never derived from provider output and never accepted from the
   * renderer. Absent only for approval surfaces that genuinely have no
   * conversation (boot-time and plugin agent-action asks).
   *
   * Part of the {@link signApprovalRequest} preimage — see that function for
   * why absence is signed as an explicit null.
   */
  sessionId?: string;
  /**
   * Confused-deputy defense — random nonce bound to this request.
   * The renderer MUST echo this value back unchanged in the
   * {@link ApprovalDecision}. Paired with {@link hmac} for integrity.
   */
  nonce?: string;
  /**
   * Hex-encoded {@link signApprovalRequest} digest over the request's
   * `(id, nonce, toolName, sessionId, args)`. The main process re-derives this
   * from the stored pending entry on receipt of the decision and rejects on
   * mismatch.
   */
  hmac?: string;
}

/** Audit attribution for an approval surface that has no conversation. */
export const UNATTRIBUTED_APPROVAL_SESSION_ID = "unattributed-approval";

/** Fields bound into an approval request's integrity signature. */
export interface ApprovalSignatureFields {
  id: string;
  nonce: string;
  toolName: string;
  /** Conversation attribution; `undefined` is signed as an explicit null. */
  sessionId: string | undefined;
  args: unknown;
}

/**
 * Single authority for the approval integrity signature. Both the emit path
 * and the {@link ApprovalGate.resolve} verification derive from this function,
 * so the signed field set cannot drift between them.
 *
 * The preimage used to be the delimiter-joined
 * `${id}|${nonce}|${toolName}|${canonicalStringify(args)}`, which left the
 * asking conversation out of the signature entirely. It is now a single
 * canonical JSON object: every field is length-delimited by the encoder (so no
 * field can impersonate another by embedding the `|` separator) and the
 * conversation attribution is signed rather than merely carried alongside the
 * request.
 *
 * `sessionId` is encoded as an explicit `null` when the request carries no
 * attribution — `canonicalStringify` drops `undefined` keys, which would make
 * an unattributed request share a preimage with one whose attribution was
 * stripped. There is no legacy preimage: the signing key is 32 random bytes
 * minted per {@link ApprovalGate}, so every signature is created and verified
 * inside one gate lifetime and no mixed-version window can exist.
 *
 * `remoteControllerOrigin` deliberately does NOT belong here either, for a
 * different reason than the answerer below: it IS known at emit time, so
 * signing it would be possible. It would just not be worth anything. This
 * signature authenticates the round trip through the renderer — the host mints
 * it, the renderer echoes it back, and {@link ApprovalGate.resolve} compares the
 * echo against the pending entry. A field the renderer is never sent has no
 * echoed copy to authenticate; its only copy lives in the pending entry, which
 * no renderer can reach, so a signature over it would compare the host's own
 * value to itself. The property that makes the marker trustworthy is that only
 * the host can set it, not that it is tamper-evident in a transit it never
 * makes. Adding it would enlarge the preimage while proving nothing, and would
 * invite the reading that an unsigned host-only field is therefore untrusted.
 *
 * {@link ApprovalAnswerer} deliberately does NOT belong here. The signature is
 * minted when the request is emitted, and who answers is not known until the
 * answer arrives; signing that field would mean either freezing it to a guess
 * at emit time or re-signing the request at answer time, and a signature the
 * host re-issues over its own later choice proves nothing. The answerer is
 * host-derived at the point the answer is received instead — see
 * {@link ApprovalGate.resolve}.
 */
export function signApprovalRequest(
  sessionKey: Buffer,
  fields: ApprovalSignatureFields,
): string {
  const preimage = canonicalStringify({
    id: fields.id,
    nonce: fields.nonce,
    toolName: fields.toolName,
    sessionId: fields.sessionId ?? null,
    args: fields.args,
  });
  return createHmac("sha256", sessionKey).update(preimage).digest("hex");
}

/**
 * Input accepted by {@link ApprovalGate.requestAndWait} before the host seals
 * nonce/HMAC and derives the renderer-facing `requireExplicit` field.
 *
 * `forceExplicit` is deliberately one-way: callers can only make a prompt
 * stricter than the current policy, never relax it. It is used by execution
 * routes whose substrate requires per-invocation, affirmative consent.
 */
export type ApprovalRequestInput = Omit<
  ApprovalRequest,
  "requireExplicit" | "executionPlan"
> & {
  /** Host-issued safe projection; structural lookalikes are rejected before IPC. */
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
  readonly forceExplicit?: true;
  /**
   * Host-only memory capability for this request. One-shot approval routes set
   * this false so a renderer cannot turn a per-invocation decision into a
   * user-approval-store record. It is retained only in pending state.
   */
  readonly durableApprovalRecordAllowed?: boolean;
  /**
   * Host-only binding for an explicit plain-shell fallback permit. It is retained only
   * in the pending entry and never serialized to the renderer or audit payload.
   */
  readonly hostShellExecutionPermitBinding?: HostShellExecutionPermitBinding;
  /**
   * Host-only marker: a remote controller's turn raised this approval, and
   * which controller it was.
   *
   * Set by the host from the invocation context's `RemoteControllerAuthority`
   * via the single {@link remoteControllerOriginOf} projection — that authority
   * object is the only non-forgeable evidence a remote controller is behind the
   * turn. It is deliberately NOT a field of {@link ApprovalRequest}: the
   * renderer neither supplies it nor receives it, so there is no copy of it for
   * a compromised renderer to author or to alter in transit.
   *
   * It is never recovered from `reason` either. `reason` is localizable free
   * text a caller composes for a human to read; a value anything can write into
   * a display string is not a fact about where the request came from.
   *
   * Absent means the host saw no remote-controller authority, which is what a
   * desk-originated approval looks like.
   */
  readonly remoteControllerOrigin?: RemoteControllerOrigin;
  /**
   * Host-only: the live authority object the marker above was projected from.
   *
   * The marker records what was true when the request was built; this is the
   * thing that can still be asked. {@link AwayAuthority} re-checks it at the
   * moment it answers, so a share revoked while the turn was in flight is not
   * answered by a grant that was valid when the turn started. Nothing else in
   * the gate reads it, and like the marker it never reaches the renderer, the
   * audit payload, or pending state.
   */
  readonly remoteControllerAuthority?: RemoteControllerAuthority;
  /**
   * Host-only: EVERY path this call would touch, for scope checks that must not
   * be satisfied by the single path the dock happens to display.
   *
   * `target.filePath` is a display field and is the FIRST extracted path only.
   * A tool declaring more than one path field — `move_file` names a source and
   * a destination — would pass a check that read the display value while the
   * other path went anywhere. Like the other host-only fields it is destructured
   * out before the renderer payload is built.
   */
  readonly scopeTargetFilePaths?: readonly string[];
  /**
   * Host-only: the abort signal of the turn this ask belongs to.
   *
   * Without it a parked approval observes nothing but its own five-minute
   * timer. The owner's Stop aborts the turn's controller and then waits that
   * timer out, still holding the conversation's execution lease, which is what
   * makes an unanswerable approval a lockout rather than a stalled tool call.
   *
   * It is the same signal the caller already tests immediately before asking,
   * so this is the closing half of an existing check rather than a new
   * mechanism: that test covers "already aborted", this covers "aborted while
   * parked". The other interactive gates on the turn path take it already —
   * `AskUserQuestionGate.ask` directly, and the rationale flow through
   * {@link ApprovalGate.cancelPendingRationale} — so a wait that ignores the
   * turn's abort is the outlier here, not the precedent.
   *
   * Like the fields above it, it never reaches the renderer, the pending
   * entry, or an audit payload. Absent means the caller has no turn to be
   * stopped, and the request then behaves exactly as it did without it.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Host-only: the sub-agent run behind this ask, and the task its parent
   * wrote for it.
   *
   * Presence is what makes an ask a candidate for parent adjudication at all,
   * so it is a fact only the host may state. It is attached by the sub-agent
   * approval adapter from the tracked run it wraps — never from tool arguments,
   * never from `reason`, and never from anything a child or a renderer wrote.
   *
   * `spawnTaskSummary` is a host truncation of the task the PARENT authored
   * when it spawned the child. Child-authored text is deliberately absent:
   * evidence a child can write is evidence a child can use to argue for its own
   * approval.
   *
   * Like the host-only fields above it, it lives on the input type rather than
   * on {@link ApprovalRequest} — the renderer neither supplies it nor receives
   * it, so there is no copy for a compromised renderer to author or alter.
   */
  readonly childProvenance?: ChildAgentProvenance;
  /**
   * Host-only: the caller's assertion that this ask cleared the preconditions
   * for tier 2 that only the caller can see — the permission layer it came
   * from, and whether policy forced it to a modal.
   *
   * It is a NECESSARY condition, never a sufficient one. The gate re-derives
   * every check it can see for itself (request kind, one-shot high-risk plan,
   * remote origin, verdict ceiling) regardless of this value, so a caller that
   * set it wrongly widens nothing the gate owns.
   */
  readonly parentAdjudicationEligible?: boolean;
};

/**
 * The sub-agent run behind an approval ask.
 *
 * Every field is host-owned: the ids come from the run registry and the summary
 * from the parent's own spawn input.
 */
interface ChildAgentProvenance {
  /** Session id of the child run whose turn raised the ask. */
  childSessionId: string;
  /** Display title of the child run, as the dock already labels it. */
  childTitle: string;
  /** Session the child was spawned from — the parent that would adjudicate. */
  originSessionId: string;
  /** Host truncation of the parent-authored spawn task. */
  spawnTaskSummary: string;
  /**
   * Whether the run executes in the background — the host's own fact about
   * how it was started, never the child model's.
   *
   * Absent means foreground, which is the answer that keeps the pre-existing
   * modal route: a run whose posture the host cannot establish is treated as
   * one somebody is watching.
   */
  background?: boolean;
}

/**
 * Why the sub-agent approval chain reached the user after tier 2 ran.
 *
 * Every cause the adjudicator itself can answer with, plus one the gate owns:
 * the module answers one call at a time and cannot see that it is answering the
 * same call for the third time, so the repetition cause can only be raised
 * here, where the counter lives.
 */
/**
 * Display bound for {@link ParentEscalationNotice.childTitle}. The dock line is
 * one row; a run titled with a whole paragraph would push the parent's reason
 * and the buttons off the visible card.
 */
const PARENT_ESCALATION_CHILD_TITLE_MAX = 120;

/**
 * Make a child run's title safe to put in front of the user.
 *
 * The title reads like host metadata and is not: `agent_spawn` takes it from
 * the parent model's tool arguments, unbounded and unfiltered, and the run
 * registry carries it verbatim. Every other place that shows a sub-agent title
 * masks it (`maskSubAgentText` in the runner), and the sibling fields of this
 * very notice are masked and sanitized too — so this one is masked for secrets
 * and normalized for the invisible/bidi characters that let a label lie about
 * what it says.
 */
function displaySafeChildTitle(title: string): string {
  return displaySafeLabel(
    maskSensitiveData(title).masked,
    PARENT_ESCALATION_CHILD_TITLE_MAX,
  );
}

/** Bound for the deferred queue's one-line description of a queued ask. */
const DEFERRED_ESCALATION_SUMMARY_MAX = 1_000;

/** (child run, tool) pairs whose queue entry is remembered for coalescing. */
const MAX_TRACKED_DEFERRED_PAIRS = 500;

/**
 * The line the deferred-queue panel shows for a queued sub-agent escalation.
 *
 * Every part is host-owned: the cause is one of a closed set the gate itself
 * assigns, the child title is masked and display-normalised, and the arguments
 * go through the same bound-then-mask pass the evidence uses. The
 * adjudicator's sentence is not here — see the caller.
 */
function deferredEscalationSummary(
  request: ApprovalRequest,
  notice: ParentEscalationNotice,
  childProvenance: ChildAgentProvenance,
): string {
  let masked: string;
  try {
    masked = canonicalStringify(
      maskArgsForDisplay(boundedEvidenceArgs(request.args), new Set<string>()),
    );
  } catch {
    masked = "[unserializable input]";
  }
  const head = `[sub-agent escalation cause=${notice.cause} child=${displaySafeChildTitle(childProvenance.childTitle)}] `;
  return `${head}${masked}`.slice(0, DEFERRED_ESCALATION_SUMMARY_MAX);
}

/**
 * Everything the gate needs to run tier 2, supplied by boot.
 *
 * All three are accessors rather than values, and for the same reason: the
 * gate is constructed before the reviewer is wired and outlives every re-wire
 * of it. A captured adjudicator would still be the boot-time stand-in after a
 * login healed the reviewer, and a captured policy would still be the
 * boot-time ceiling after the user narrowed it. Absent deps mean no tier 2 at
 * all — the chain is then exactly the two-tier one that shipped before it.
 */
export interface ParentAdjudicationGateDeps {
  /**
   * The live adjudicator for the model source the policy names, re-read per
   * ask. The source is passed rather than resolved here so one setting change
   * moves the next ask onto the other model with nothing to re-wire.
   */
  adjudicator: (source: ParentAdjudicationModelSource) => ParentAdjudicator;
  /** The feature flag. False means the stage does not run at all. */
  isEnabled: () => boolean;
  /** The live tier-2 policy block. */
  policy: () => ReviewerParentAdjudicationBlock;
  /**
   * Recent parent-conversation turns for the evidence, when the policy asks
   * for any. Absent — or throwing, or returning nothing — simply means the
   * evidence carries no conversation block: this is context that can improve
   * an answer, never a precondition for producing one.
   */
  parentContext?: (
    parentSessionId: string,
    maxTurns: number,
  ) => readonly ParentContextTurn[];
  /**
   * The deferred-approval queue, for escalations raised by a run nobody is
   * watching. Absent means every escalation paints a dock, which is the
   * behaviour of the chain before this route existed.
   */
  deferredQueue?: () => DeferredQueue | null;
  /**
   * Whether somebody could see a dock right now — the app window existing,
   * visible, and not minimised.
   *
   * The load-bearing half of "unattended". A child run's own `background` flag
   * is not that fact by itself: this desktop host starts every locally spawned
   * child in the background, so a route keyed on it alone would divert EVERY
   * tier-3 escalation away from a user sitting in front of the app — taking
   * away the one tier the chain exists to preserve.
   *
   * Absent, or throwing, means the host cannot establish that nobody is there,
   * and an unestablished absence is treated as presence: the dock is painted.
   */
  isDeskAttended?: () => boolean;
}

/**
 * Host-only provenance for a decision a parent agent made.
 *
 * A `WeakMap` for the reason the timeout and host-rejected markers above are
 * `WeakSet`s: provenance is a fact about the exact object the host created,
 * and a structural `{ choice: "allow-once" }` arriving from anywhere else can
 * never be in it. The reason rides here rather than on
 * {@link ApprovalDecision} because that type is renderer-supplied — a field on
 * it would be a field a renderer could author.
 */
const parentAdjudicatedDecisions = new WeakMap<
  ApprovalDecision,
  ParentAdjudicationProvenance
>();

/** What the parent answered, for the consumers of the child's turn. */
interface ParentAdjudicationProvenance {
  outcome: "allow-once" | "deny";
  reason: string;
}

/** The parent's answer behind a decision, or undefined if no parent answered. */
export function parentAdjudicationOf(
  decision: ApprovalDecision | null | undefined,
): ParentAdjudicationProvenance | undefined {
  if (decision === null || decision === undefined) return undefined;
  return parentAdjudicatedDecisions.get(decision);
}

function markParentAdjudicatedDecision(
  decision: ApprovalDecision,
  provenance: ParentAdjudicationProvenance,
): ApprovalDecision {
  parentAdjudicatedDecisions.set(decision, provenance);
  return decision;
}

/**
 * Host-only provenance for an escalation that went to the deferred queue
 * instead of to a dock. A `WeakMap` for the reason the one above it is: this
 * is a fact about the exact object the gate created.
 */
const deferredEscalatedDecisions = new WeakMap<
  ApprovalDecision,
  DeferredEscalationProvenance
>();

/** What the child's turn is told about an ask that was queued, not shown. */
interface DeferredEscalationProvenance {
  /** Why tier 2 gave up on answering it. */
  cause: ParentEscalationNotice["cause"];
  /** Queue entry the user will review. */
  deferredId: string;
}

/** The queue entry behind a decision, or undefined if none was created. */
export function deferredParentEscalationOf(
  decision: ApprovalDecision | null | undefined,
): DeferredEscalationProvenance | undefined {
  if (decision === null || decision === undefined) return undefined;
  return deferredEscalatedDecisions.get(decision);
}

/** How the tier-2 stage ended, for the one caller that runs it. */
type ParentAdjudicationStageOutcome =
  /** The parent answered, and its answer is the decision. */
  | { kind: "answered"; decision: ApprovalDecision }
  /** The ask continues to the dock, carrying this notice. */
  | { kind: "escalate"; notice: ParentEscalationNotice };

export type ApprovalChoice =
  "allow-once" | "allow-session" | "allow-always" | "deny-once" | "deny-always";

export interface ApprovalDecision {
  requestId: string;
  choice: ApprovalChoice;

  rememberPattern?: string;
  /**
   * One-shot structured content captured by renderer-only approval surfaces.
   * Currently used for MCP `elicitation/create` form-mode requests; never
   * persisted in the user-approval memory store.
   */
  elicitationContent?: Record<string, unknown>;
  /**
   * Nonce originally issued with the {@link ApprovalRequest}. The
   * renderer echoes it back verbatim. Missing or mismatched values cause
   * the decision to be rejected and treated as deny-once.
   */
  nonce?: string;
  /**
   * HMAC originally issued with the {@link ApprovalRequest}. Echoed
   * back by the renderer. The main process re-computes the expected HMAC
   * from the pending entry and compares using timingSafeEqual.
   */
  hmac?: string;
}

export const IPC_APPROVAL_REQUEST = "lvis:approval:request";
export const IPC_APPROVAL_RESPOND = "lvis:approval:respond";

/** Host-only timeout provenance; renderer objects can never enter this set. */
const hostTimeoutDecisions = new WeakSet<ApprovalDecision>();

export function isHostApprovalTimeoutDecision(
  decision: ApprovalDecision | null | undefined,
): decision is ApprovalDecision {
  return (
    decision !== null &&
    decision !== undefined &&
    hostTimeoutDecisions.has(decision)
  );
}

/** Host-generated fail-closed denials are not user-authored deny choices. */
const hostRejectedApprovalDecisions = new WeakSet<ApprovalDecision>();

export function isHostApprovalRejectedDecision(
  decision: ApprovalDecision | null | undefined,
): decision is ApprovalDecision {
  return (
    decision !== null &&
    decision !== undefined &&
    hostRejectedApprovalDecisions.has(decision)
  );
}

function markHostApprovalRejectedDecision(
  decision: ApprovalDecision,
): ApprovalDecision {
  hostRejectedApprovalDecisions.add(decision);
  return decision;
}

// Renderer-visible approval decisions are ordinary objects. This private map
// records the exact object that completed an HMAC-verified, explicit, one-shot
// Plan-B approval, so a structural `{ choice: "allow-once" }` cannot mint a
// plain-shell capability.
const hostApprovedOneShotExecutionBindings = new WeakMap<
  ApprovalDecision,
  HostShellExecutionPermitBinding
>();

function sameHostShellExecutionPermitBinding(
  actual: HostShellExecutionPermitBinding,
  expected: HostShellExecutionPermitBinding,
): boolean {
  return (
    actual.planIdentity === expected.planIdentity &&
    actual.plan === expected.plan &&
    actual.toolName === expected.toolName &&
    actual.toolUseId === expected.toolUseId &&
    actual.command === expected.command &&
    actual.requestedCwd === expected.requestedCwd &&
    actual.executionCwd === expected.executionCwd &&
    actual.resolvedCwd === expected.resolvedCwd &&
    actual.timeoutSeconds === expected.timeoutSeconds &&
    actual.allowedDirectories.length === expected.allowedDirectories.length &&
    actual.allowedDirectories.every(
      (directory, index) => directory === expected.allowedDirectories[index],
    )
  );
}

/**
 * The Plan-B binding is deliberately renderer-invisible, but it must describe
 * exactly the shell action the renderer is asked to approve. Otherwise an
 * in-process caller could present a benign request while retaining a binding
 * for a different plain-host spawn. Normalize only the schema-relevant shell
 * fields so an omitted default timeout has the same meaning on both sides.
 */
function matchesHostShellExecutionPermitBindingRequest(
  request: Omit<ApprovalRequest, "requireExplicit">,
  binding: HostShellExecutionPermitBinding,
): boolean {
  if (
    request.category !== "tool" ||
    (request.kind !== undefined && request.kind !== "tool") ||
    request.source !== "builtin" ||
    request.toolCategory !== "shell" ||
    request.toolName !== binding.toolName
  ) {
    return false;
  }
  try {
    const parsed = parseHostShellExecutionInput(request.args);
    if (parsed === undefined) return false;
    return canonicalStringify({
      command: parsed.command,
      cwd: parsed.cwd ?? null,
      timeoutSeconds: parsed.timeoutSeconds,
    }) === canonicalStringify({
      command: binding.command,
      cwd: binding.requestedCwd ?? null,
      timeoutSeconds: binding.timeoutSeconds,
    });
  } catch {
    // A malformed/proxy argument or binding is never approval-equivalent.
    return false;
  }
}

/**
 * Verify and burn the host-only receipt for a Plan-B execution permit. A
 * mismatch is terminal for that receipt to prevent action probing or replay.
 */
export function consumeHostApprovedOneShotExecutionBinding(
  decision: ApprovalDecision | undefined,
  expected: HostShellExecutionPermitBinding,
): boolean {
  if (decision === undefined) return false;
  const actual = hostApprovedOneShotExecutionBindings.get(decision);
  if (actual === undefined) return false;
  hostApprovedOneShotExecutionBindings.delete(decision);
  return sameHostShellExecutionPermitBinding(actual, expected);
}

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Permission origin captured with the approval prompt. */
  trustOrigin: string;
  /**
   * Conversation attribution captured with the prompt, so the decided /
   * timeout / cancelled audit rows name the same conversation the requested
   * row did even though the request object is long gone by then.
   */
  sessionId?: string;
  /**
   * Remote-controller origin captured with the prompt. Host-only, exactly as it
   * is on {@link ApprovalRequestInput} — it is retained here and never sent
   * anywhere, so the rows written long after the request object is gone
   * (decided, timeout, cancelled) can still state where the blocked turn came
   * from.
   */
  remoteControllerOrigin?: RemoteControllerOrigin;
  toolName: string;
  /** Raw host-owned finalized input; never forwarded from this pending entry. */
  args: unknown;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  allowedChoices?: readonly ApprovalChoice[];
  toolCategory?: ToolCategory;
  /** Host-derived verdict shown by the renderer and enforced for recording. */
  verdictAtApproval: RiskVerdict["level"];
  source?: "builtin" | "plugin" | "mcp";
  sourcePluginId?: string;
  approvalScope?: string;
  /**
   * Host-resolved directory scope carried from the request. `/allow` reads it
   * from HERE, not from the renderer's copy: the renderer sends only a request
   * id and a sentence, so the paths an approval sentence can ever resolve to
   * are the ones this process derived when it raised the prompt.
   */
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
  };
  /**
   * Issue #799 — approval cache key captured server-side at request emit
   * time. The userApprovalRecord IPC handler reads this via
   * {@link ApprovalGate.getRequestSnapshot} instead of trusting the renderer
   * to echo it back. Optional because non-tool kinds (out-of-allowed-dir,
   * agent-action) do not propagate a cache key.
   */
  approvalCacheKey?: string;
  /** Host-owned permission to create a user-approval-store record. */
  durableApprovalRecordAllowed: boolean;
  executionPlan?: HostShellExecutionPlanAuditProjection;
  hostShellExecutionPermitBinding?: HostShellExecutionPermitBinding;
  /** Confused-deputy nonce issued for this request (echoed back verbatim) */
  nonce: string;
  /** Expected HMAC for this request (confused-deputy defense) */
  expectedHmac: string;
}

/**
 * Host-internal view of one parked approval, handed to a registered
 * {@link PendingApprovalObserver}.
 *
 * It exists so a second host-owned answer surface (the paired chat-platform
 * bridge card) can offer a decision for a request WITHOUT growing a second
 * resolution path: the observer holds exactly the echo material the renderer
 * holds — the request id, nonce, and HMAC — and answers through the same
 * {@link ApprovalGate.resolve} chokepoint, subject to the same integrity and
 * allowed-choice checks. It deliberately carries no arguments, no paths, no
 * reason text, and no verdict: an observer that renders a remote card gets the
 * coarse identity fields only, mirroring the shared projection's approval
 * event.
 *
 * Main-process only. Nothing here may cross IPC or a provider wire; the nonce
 * and HMAC in particular are resolution capability, which is why this view is
 * only reachable through {@link ApprovalGate.observePendingApprovals} — a
 * registration surface no renderer or provider payload can call.
 */
export interface PendingApprovalView {
  readonly requestId: string;
  readonly toolName: string;
  readonly source?: "builtin" | "plugin" | "mcp";
  readonly category: "tool" | "agent-action";
  readonly kind?: ApprovalKind;
  readonly allowedChoices?: readonly ApprovalChoice[];
  /** Conversation attribution, as on the request; never renderer-supplied. */
  readonly sessionId?: string;
  /** Echo material {@link ApprovalGate.resolve} verifies; host-internal only. */
  readonly nonce: string;
  readonly hmac: string;
}

/**
 * Host-internal observer of the gate's pending set.
 *
 * `onPending` fires when a request is parked for an interactive answer — after
 * every host-only short circuit (sensitive-path block, read-only
 * auto-approve, away answer, parent answer), so an observer can never offer a
 * decision the desk was never offered. `onSettled` fires exactly when the
 * parked request stops being answerable, whatever settled it: a desk answer, a
 * remote answer, the timeout, a turn abort, a cancel, or shutdown. Observers
 * must tolerate `onSettled` for ids they never saw and must never throw;
 * a throwing observer is swallowed so it cannot alter approval flow.
 */
export interface PendingApprovalObserver {
  onPending(view: PendingApprovalView): void;
  onSettled(requestId: string, decision: ApprovalDecision): void;
}

/**
 * Audit vocabulary for who answered an approval, and the closed set of
 * answerers itself: {@link ApprovalAnswerer} is `keyof` this table, so the type
 * cannot gain a member without that member also declaring the token it writes
 * to the audit row. This table is the single authority; there is no path that
 * widens one without the other.
 *
 * The dimension exists because an audit that cannot name the answerer cannot
 * support a review of what happened while nobody was watching. It was recorded
 * while `desk` was still the only answerer, which is what made adding the
 * second one a one-line change here rather than a retrofit across every row.
 */
const APPROVAL_ANSWERER_AUDIT_TOKENS = {
  /** The app window: a renderer response to the approval dock. */
  desk: "desk",
  /**
   * The desk-armed {@link AwayAuthority}: no window was involved, and the
   * authorization is a local gesture the owner made in advance. Distinct from
   * `desk` precisely so a reviewer can partition "the owner decided this call"
   * from "the owner pre-authorized a class of calls and this was one".
   */
  "away-authority": "away-authority",
  /**
   * The parent agent of the sub-agent whose turn raised this ask (tier 2 of the
   * sub-agent approval chain). Distinct from both of the above for the reason
   * the dimension exists at all: a row a reviewer reads later must say whether
   * a person decided this call or whether a model the person delegated to did,
   * and neither `desk` nor `away-authority` can carry that fact. A parent
   * answer is one-shot by construction, so a row bearing this token can never
   * be the origin of a durable approval record.
   */
  "parent-agent": "parent-agent",
  /**
   * The paired chat-platform surface: the owner pressed a decision button on a
   * bridge card. Distinct from `desk` for the reason the dimension exists — a
   * reviewer partitioning rows by where the owner was must not have to infer
   * "away from the desk" from surrounding rows — and distinct from
   * `away-authority` because a human answered THIS call rather than
   * pre-authorizing a class of calls. Only host code relaying a verified paired
   * owner's button press may pass it; the renderer's IPC route cannot.
   */
  "platform-bridge": "platform-bridge",
} as const;

/**
 * Who answered an approval.
 *
 * Host-derived at answer time from the code path that received the answer. It
 * is never read out of the {@link ApprovalDecision} payload, out of the request,
 * out of a provider's output, or inferred from the localizable free-text
 * `reason` — a value any of those can influence is not attribution.
 */
export type ApprovalAnswerer = keyof typeof APPROVAL_ANSWERER_AUDIT_TOKENS;

/** Audit token for a value that is not a known {@link ApprovalAnswerer}. */
const UNRECOGNIZED_APPROVAL_ANSWERER = "unrecognized-answerer";

/**
 * Render an answerer for the audit row, failing closed on anything the host
 * does not recognise.
 *
 * The type already closes the set; this check exists at runtime because this is
 * the boundary where the value becomes a durable record. A future caller with
 * an `as never` cast, or an unchecked value crossing a boundary, must not be
 * able to file an answer under a name the host never defined. Such a value
 * renders as {@link UNRECOGNIZED_APPROVAL_ANSWERER} rather than `desk`: an
 * unrecognised answerer is an audit anomaly to investigate, and recording it as
 * the default would erase the one fact the reviewer came for.
 *
 * The raw value is deliberately not echoed. Audit rows are space-delimited
 * `key=value` pairs, so an arbitrary string could otherwise forge the fields
 * that follow it, such as `choice=allow-always`. `Object.hasOwn` rather than
 * `in`, so inherited members like `toString` are not mistaken for answerers.
 */
export function approvalAnswererAuditToken(
  answeredBy: ApprovalAnswerer,
): string {
  return Object.hasOwn(APPROVAL_ANSWERER_AUDIT_TOKENS, answeredBy)
    ? APPROVAL_ANSWERER_AUDIT_TOKENS[answeredBy]
    : UNRECOGNIZED_APPROVAL_ANSWERER;
}

/**
 * Audit vocabulary for the remote controller behind an approval.
 *
 * A TOTAL `Record` over the authority kinds. `RemoteControllerOrigin` is owned
 * by `shared/chat-origin.ts`, which is where the set of controllers is decided;
 * making the table total means a new controller kind added there fails to
 * compile here until it declares the token it writes. The set keeps its one
 * owner and this table cannot silently fall behind it.
 */
const REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS: Record<
  RemoteControllerOrigin,
  string
> = {
  "tailnet-controller": "tailnet-controller",
  "platform-bridge": "platform-bridge",
};

/** Audit token for an approval no remote controller stands behind. */
const LOCAL_APPROVAL_ORIGIN = "none";

/** Audit token for a value that is not a known {@link RemoteControllerOrigin}. */
const UNRECOGNIZED_REMOTE_CONTROLLER_ORIGIN = "unrecognized-remote-origin";

/**
 * Render the remote origin for the audit row.
 *
 * Written on every approval row, `none` included. An absent key cannot separate
 * "the desk raised this" from "whoever wrote this row never carried the marker",
 * and the point of a positive host-set marker is that a reviewer partitioning
 * rows by origin does not have to assume which one an absence meant.
 *
 * Fail-closed rendering, as with {@link approvalAnswererAuditToken}: rows are
 * space-delimited `key=value` pairs, so a value the host does not recognise is
 * reported as an anomaly rather than echoed into a row where it could forge the
 * fields that follow it. `Object.hasOwn` rather than `in`, so inherited members
 * like `toString` are not mistaken for controllers.
 */
export function remoteControllerOriginAuditToken(
  origin: RemoteControllerOrigin | undefined,
): string {
  if (origin === undefined) return LOCAL_APPROVAL_ORIGIN;
  return Object.hasOwn(REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS, origin)
    ? REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS[origin]
    : UNRECOGNIZED_REMOTE_CONTROLLER_ORIGIN;
}

interface ApprovalAuditFields {
  toolName: string;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  toolCategory?: ToolCategory;
  source?: "builtin" | "plugin" | "mcp";
  sourcePluginId?: string;
  approvalScope?: string;
  trustOrigin?: string;
  /**
   * Host-set marker for the remote controller behind the asking turn. Unlike
   * {@link answeredBy} it is written on every row, because every approval either
   * came from a remote turn or did not — there is no third state for an absence
   * to encode.
   */
  remoteControllerOrigin?: RemoteControllerOrigin;
  /**
   * Set only on a row that records an actual answer. Rows for outcomes the
   * host reached on its own — timeout, sensitive-path hard-block, send
   * failure, cancellation, read-only auto-approve — leave it undefined,
   * because "nobody answered" is a different fact from "the desk answered"
   * and the row marker already names which host outcome it was.
   */
  answeredBy?: ApprovalAnswerer;
}

function formatApprovalAuditFields(
  fields: ApprovalAuditFields,
  executionPlan?: HostShellExecutionPlanAuditProjection,
): string {
  return [
    `toolName=${fields.toolName}`,
    `category=${fields.category}`,
    `toolCategory=${fields.toolCategory ?? "unknown"}`,
    `kind=${fields.kind ?? "tool"}`,
    `source=${fields.source ?? "unknown"}`,
    `sourcePluginId=${fields.sourcePluginId ?? "none"}`,
    `approvalScope=${fields.approvalScope ?? "none"}`,
    `trustOrigin=${fields.trustOrigin ?? "unknown"}`,
    `remoteControllerOrigin=${remoteControllerOriginAuditToken(fields.remoteControllerOrigin)}`,
    ...(fields.answeredBy === undefined
      ? []
      : [`answeredBy=${approvalAnswererAuditToken(fields.answeredBy)}`]),
    ...(executionPlan === undefined ? [] : [
      `executionPlan.version=${executionPlan.version}`,
      `executionPlan.identity=${executionPlan.identity}`,
      `executionPlan.platform=${executionPlan.platform}`,
      `executionPlan.requestedSandbox=${executionPlan.requestedSandbox}`,
      `executionPlan.mode=${executionPlan.mode}`,
      `executionPlan.fallbackReason=${executionPlan.fallbackReason}`,
      `executionPlan.requiresExplicitUserApproval=${executionPlan.requiresExplicitUserApproval}`,
      `executionPlan.capability.kind=${executionPlan.capability.kind}`,
      `executionPlan.capability.confidence=${executionPlan.capability.confidence}`,
      `executionPlan.capability.confines=${JSON.stringify(executionPlan.capability.confines ?? {})}`,
    ]),
  ].join(" ");
}
/**
 * Rationale cards have a narrow, host-audited display contract. Reject every
 * malformed or semantically mismatched request before it can mint integrity
 * material, notify the user, or cross the main-to-renderer boundary.
 */
function parseValidRationaleApprovalDisplay(
  request: Omit<ApprovalRequest, "requireExplicit">,
): RationaleApprovalDisplay | null {
  if (request.kind !== "rationale") return null;
  try {
    const display = parseRationaleApprovalDisplay(request.args);
    return display !== null &&
      request.category === "tool" &&
      request.toolName === display.toolName &&
      request.reviewerVerdict !== undefined &&
      canonicalStringify(request.reviewerVerdict) ===
        canonicalStringify(display.effectiveVerdict)
      ? display
      : null;
  } catch {
    return null;
  }
}

/**
 * Rationale requests are assembled from a host-sealed projection, but callers
 * still supply the generic ApprovalRequest shape. Never let that generic
 * `reason` field become notification, audit, pending-state, or renderer data:
 * it is not part of the rationale display contract and could otherwise carry
 * model-controlled text.
 */
const RATIONALE_HOST_OWNED_REASON =
  "Review the host-sealed action and its permission rationale.";

/**
 * The renderer needs an opaque request id to respond and a bounded rationale
 * display card to inform the one-shot decision. It does not need execution
 * metadata. Keep the full request in the main process for sensitive-path
 * enforcement, audit, pending state, and HMAC verification, then whitelist
 * this separate IPC payload after signing.
 */
function createRendererSafeRationaleApprovalRequest(
  request: ApprovalRequest,
  display: RationaleApprovalDisplay,
  detections: Set<string>,
): ApprovalRequest {
  const maskedVerdict = maskSensitiveData(display.effectiveVerdict.reason);
  for (const hit of maskedVerdict.detections) detections.add(hit);
  return {
    id: request.id,
    category: "tool",
    kind: "rationale",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: display.toolName,
    reviewerVerdict: {
      level: display.effectiveVerdict.level,
      reason: maskedVerdict.masked,
    },
    // Emission integrity: the display was parse-guaranteed at construction and
    // masking was the one mutation applied after that guarantee — a mask token
    // pushing a near-cap field over its limit made the renderer's parse return
    // null and the card lost its tool identity entirely. Seal per field with
    // parser-identical validators so what ships ALWAYS parses; the renderer's
    // null branch stays as defense-in-depth for forged payloads only.
    args: sealMaskedRationaleApprovalDisplay(display, (value) => {
      const { masked, detections: hits } = maskSensitiveData(value);
      for (const hit of hits) detections.add(hit);
      return masked;
    }) as unknown as Record<string, unknown>,
    reason: RATIONALE_HOST_OWNED_REASON,
    createdAt: request.createdAt,
    requireExplicit: true,
    // Attribution is an opaque host-owned id, not conversation content, and a
    // rationale card blocks a conversation the same way a tool ask does.
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    nonce: request.nonce,
    hmac: request.hmac,
  };
}

/**
 * Constant-time comparison of the echoed (nonce, hmac) pair against
 * the pending entry's expected values (confused-deputy defense). Returns
 * false if either field is missing or malformed; returns true only when
 * both the nonce and HMAC match byte-for-byte.
 */
function verifyApprovalIntegrity(
  entry: PendingEntry,
  decision: ApprovalDecision,
): boolean {
  const { nonce, hmac } = decision;
  if (typeof nonce !== "string" || typeof hmac !== "string") return false;
  if (nonce.length !== entry.nonce.length) return false;
  if (hmac.length !== entry.expectedHmac.length) return false;
  const nonceA = Buffer.from(nonce);
  const nonceB = Buffer.from(entry.nonce);
  const hmacA = Buffer.from(hmac);
  const hmacB = Buffer.from(entry.expectedHmac);
  if (nonceA.length !== nonceB.length || hmacA.length !== hmacB.length) {
    return false;
  }
  return timingSafeEqual(nonceA, nonceB) && timingSafeEqual(hmacA, hmacB);
}

// ─── ApprovalGate ────────────────────────────────────

export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly webContents: WebContents;
  /** Timeout in milliseconds. Defaults to five minutes. */
  private readonly timeoutMs: number;
  /** Active policy, replaceable at runtime via setPolicy(). */
  private currentPolicy: PolicyFile;
  /** Audit logger for scenario S8; silent when not provided. */
  private readonly auditLogger?: AuditLogger;
  /**
   * Issue #260: optional NotificationService — when supplied, the gate fires
   * an `approval` system notification at the entry of `requestAndWait` so
   * the user sees the prompt even if the window is backgrounded.
   */
  private readonly notificationService?: NotificationService;
  /**
   * Per-instance HMAC secret for confused-deputy defense. 32 random bytes
   * generated at construction time. Never leaves the main process — used only
   * to sign/verify the nonce that rides along with approval requests. A fresh
   * key each boot naturally scopes replay protection to the current ApprovalGate lifetime.
   */
  private readonly sessionKey: Buffer = randomBytes(32);

  /** Host-internal observers of the pending set; see {@link observePendingApprovals}. */
  private readonly pendingObservers = new Set<PendingApprovalObserver>();

  /**
   * The desk-armed second answerer. Owned by the gate rather than reachable
   * beside it: an answerer that could be consulted anywhere else would be a
   * second answer surface, and the whole argument for this feature is that
   * there is exactly one and it sits below every hard gate.
   */
  private readonly awayAuthority = new AwayAuthority();

  /**
   * Tier 2 of the sub-agent approval chain, when boot wired one. Owned by the
   * gate for the same reason the away answerer is: an answerer reachable
   * beside the gate would be a second answer surface, and the argument for
   * both is that there is exactly one and it sits below every hard check.
   */
  private readonly parentAdjudication?: ParentAdjudicationGateDeps;

  /** Consecutive parent denials, keyed by child run and tool. */
  private readonly parentDenialStreaks = new Map<string, number>();

  /**
   * Queue entries already raised for a (child run, tool) pair.
   *
   * A child that has spent its adjudication budget escalates on EVERY
   * subsequent call, and a route that appended a row and rang the OS for each
   * of them would turn one runaway loop into hundreds of identical rows and
   * toasts — burying the entries a user might actually act on. The first ask
   * of a pair is recorded and announced; the rest are still denied, and are
   * told they belong to the entry already waiting.
   *
   * Bounded and evicted oldest-first, because a run ends without telling this
   * map. Eviction only costs a second queue row for a pair that has been idle
   * behind this many others, which no live run reaches.
   */
  private readonly deferredEscalationEntries = new Map<string, string>();

  constructor(
    webContents: WebContents,
    initialPolicy?: PolicyFile,
    timeoutMs = TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs,
    auditLogger?: AuditLogger,
    notificationService?: NotificationService,
    parentAdjudication?: ParentAdjudicationGateDeps,
  ) {
    this.webContents = webContents;
    this.timeoutMs = timeoutMs;
    this.auditLogger = auditLogger;
    this.notificationService = notificationService;
    this.parentAdjudication = parentAdjudication;
    this.currentPolicy = initialPolicy ?? {
      version: 1,
      requireExplicitApproval: true,
      managed: false,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Replace the runtime policy immediately from the lvis:policy:set IPC handler.
   */
  setPolicy(p: PolicyFile): void {
    this.currentPolicy = p;
  }

  /**
   * Arm the away answerer from a desk gesture. Returns whether it took.
   *
   * The single entry point: the raw request is validated by
   * `parseAwayAuthorityGrant`, which is where every bound on a legal grant
   * lives, and a rejected request arms nothing. A caller cannot hand this
   * method a pre-built grant, so there is no second place that decides what a
   * legal grant is.
   */
  armAwayAuthority(input: AwayAuthorityArmInput): boolean {
    const grant = parseAwayAuthorityGrant(input, Date.now());
    if (grant === null) return false;
    this.awayAuthority.arm(grant);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: grant.conversationId,
      type: "approval",
      // The directory count, not the directories: an audit row states what was
      // armed, and local paths are exactly the material the rest of this
      // feature exists to keep off a remote transport.
      output: `[approval:away-armed] categories=${grant.categories.join(",")} directories=${grant.directories.length} budget=${grant.budget} expiresAt=${new Date(grant.expiresAt).toISOString()}`,
    });
    return true;
  }

  /**
   * Retire any armed grant.
   *
   * Called for desk disarm and — the reason it is public rather than private to
   * the answerer's own expiry logic — from the share lifecycle chokepoint. A
   * revoke, re-share, pause, disconnect or re-pair mints a fresh authority that
   * the per-call re-check would happily accept; the grant behind it was made
   * for the share that no longer exists.
   */
  retireAwayAuthority(reason: "desk-disarm" | "share-lifecycle"): boolean {
    const retired = this.awayAuthority.retireAll();
    if (retired) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:away-retired] reason=${reason}`,
      });
    }
    return retired;
  }

  /** Current grant state for the desk surface that displays it. */
  awayAuthoritySnapshot(): AwayAuthoritySnapshot | null {
    return this.awayAuthority.snapshot();
  }

  /**
   * Register a host-internal observer of parked approvals. Returns the
   * unsubscribe. See {@link PendingApprovalView} for what an observer receives
   * and why registration is the only way to receive it.
   */
  observePendingApprovals(observer: PendingApprovalObserver): () => void {
    this.pendingObservers.add(observer);
    return () => {
      this.pendingObservers.delete(observer);
    };
  }

  /** Fan one parked request out to observers; a throwing observer is inert. */
  private notifyPendingParked(view: PendingApprovalView): void {
    for (const observer of [...this.pendingObservers]) {
      try {
        observer.onPending(view);
      } catch {
        // An observer failure must never alter approval flow.
      }
    }
  }

  /** Fan one settlement out to observers; a throwing observer is inert. */
  private notifyPendingSettled(
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    for (const observer of [...this.pendingObservers]) {
      try {
        observer.onSettled(requestId, decision);
      } catch {
        // An observer failure must never alter approval flow.
      }
    }
  }

  /**
   * Count one parent denial and report the streak length including it.
   *
   * The key pairs the child run with the tool: a parent refusing `fs_write`
   * has said nothing about the same child's `web_fetch`, and a streak that
   * mixed them would escalate an unrelated call.
   */
  private recordParentDenial(childSessionId: string, toolName: string): number {
    const key = canonicalStringify([childSessionId, toolName]);
    const streak = (this.parentDenialStreaks.get(key) ?? 0) + 1;
    // Re-insert so map order stays least-recently-used for eviction.
    this.parentDenialStreaks.delete(key);
    this.parentDenialStreaks.set(key, streak);
    if (this.parentDenialStreaks.size > MAX_TRACKED_PARENT_DENIAL_KEYS) {
      const oldest = this.parentDenialStreaks.keys().next();
      if (!oldest.done) this.parentDenialStreaks.delete(oldest.value);
    }
    return streak;
  }

  /** End a streak. Called by an allow, and by the escalation the streak causes. */
  private clearParentDenialStreak(
    childSessionId: string,
    toolName: string,
  ): void {
    this.parentDenialStreaks.delete(
      canonicalStringify([childSessionId, toolName]),
    );
  }

  /**
   * Decide whether tier 2 of the sub-agent approval chain may run for this ask,
   * and return what running it would need. `null` means it may not.
   *
   * Synchronous, and deliberately so: it is the whole eligibility decision, so
   * an ask that is not adjudicated never awaits anything and reaches the dock
   * exactly as it did before this lane existed.
   *
   * It re-derives every precondition it can observe rather than trusting the
   * caller's eligibility flag, which is therefore a necessary condition and
   * never a sufficient one. It is also positioned rather than merely written:
   * its one caller runs below every hard check in {@link requestAndWait}, so no
   * answer this lane produces can re-open a sensitive-path block, a binding
   * mismatch or a destroyed-window deny.
   */
  private parentAdjudicationLane(input: {
    request: ApprovalRequest;
    /** The caller's assertion about the facts only the caller can see. */
    callerEligible: boolean;
    forceExplicit: boolean;
    oneShotPermitBound: boolean;
    highRiskOneShot: boolean;
    remoteControllerOrigin?: RemoteControllerOrigin;
  }): {
    deps: ParentAdjudicationGateDeps;
    policy: ReviewerParentAdjudicationBlock;
    verdict: RiskVerdict;
  } | null {
    const deps = this.parentAdjudication;
    if (deps === undefined) return null;

    const { request } = input;
    const verdict = request.reviewerVerdict;
    // The flag and the ceiling are read from disk-backed settings, so both are
    // an external boundary that can fail. A failure here means the host cannot
    // establish that this lane is permitted, and an unestablished permission is
    // a denied one: the ask falls through to the user, which is the behaviour
    // of the chain with the lane switched off.
    let policy: ReviewerParentAdjudicationBlock;
    try {
      // The flag first, and the policy only after it: reading the policy opens
      // the permission settings file, and a lane that is switched off must not
      // put a synchronous file read on the approval path of every sub-agent
      // ask it is not going to touch.
      if (!deps.isEnabled()) return null;
      policy = deps.policy();
    } catch {
      return null;
    }
    // Every condition the gate can see for itself, checked here regardless of
    // what the caller asserted:
    //   - kind: only an ordinary tool ask. A directory-scope grant, a plugin
    //     agent-action and a rationale card are each a decision about the
    //     user's own authority, not about whether a child's call serves its
    //     task.
    //   - mode: `ask_all` and `plan` are the user saying "show me every one of
    //     these", which a lane that answers some of them would contradict.
    //   - remote origin: a call a remote controller's turn raised is answered
    //     at the desk or not at all.
    //   - forceExplicit / a bound one-shot permit: substrates that require
    //     per-invocation human consent.
    //   - a HIGH verdict, or none at all: the ceiling, enforced before the
    //     parent is asked rather than applied to its answer.
    const withinCeiling =
      verdict !== undefined &&
      RISK_LEVEL_RANK[verdict.level] <= RISK_LEVEL_RANK[policy.maxVerdict];
    const eligible =
      input.callerEligible &&
      (request.kind === undefined || request.kind === "tool") &&
      request.category === "tool" &&
      request.toolCategory !== "meta" &&
      request.mode !== "ask_all" &&
      request.mode !== "plan" &&
      input.remoteControllerOrigin === undefined &&
      !input.forceExplicit &&
      !input.oneShotPermitBound &&
      !input.highRiskOneShot &&
      withinCeiling;
    if (!eligible || verdict === undefined) return null;
    return { deps, policy, verdict };
  }

  /**
   * The evidence's optional parent-conversation block, or nothing.
   *
   * Nothing is the default and nothing is also every failure: the reader opens
   * a transcript file, which is an external boundary, and a lane that could not
   * read it still has a task summary and a verdict to judge with. The turns
   * themselves are composed by the reader the host wired — bounding, masking
   * and the exclusion of child-authored entries all live there, in one place,
   * rather than at each of this method's would-be call sites.
   */
  private parentContextBlock(
    policy: ReviewerParentAdjudicationBlock,
    parentSessionId: string,
  ): { parentContext?: readonly ParentContextTurn[] } {
    const read = this.parentAdjudication?.parentContext;
    if (read === undefined || policy.includeParentContextTurns <= 0) return {};
    let turns: readonly ParentContextTurn[];
    try {
      turns = read(parentSessionId, policy.includeParentContextTurns);
    } catch {
      return {};
    }
    return turns.length === 0 ? {} : { parentContext: turns };
  }

  /**
   * Whether anyone could see a dock right now. Unknown counts as yes.
   *
   * A throwing accessor is a destroyed or half-torn-down window, and the answer
   * that keeps the user's tier is "assume they are there": the cost of being
   * wrong that way is a dock nobody reads, and the cost of being wrong the
   * other way is an approval the user never got the chance to give.
   */
  private deskAttended(): boolean {
    const read = this.parentAdjudication?.isDeskAttended;
    if (read === undefined) return true;
    try {
      return read();
    } catch {
      return true;
    }
  }

  /**
   * Route a tier-3 escalation raised by a run nobody is watching into the
   * deferred queue, and answer the ask fail-closed.
   *
   * `null` means this ask is not one of those, and the caller paints the dock
   * exactly as it did before — which is also what every failure of this route
   * returns, because a queue that could not record the ask must not be the
   * reason the user never sees it.
   *
   * What the queue entry can and cannot do afterwards is the point of routing
   * here rather than waiting out a modal nobody will answer. The decision
   * returned is a host denial: one-shot, no `rememberPattern`, no pending entry
   * for a later answer to bind to. The entry itself is appended WITHOUT a
   * `grant`, so the resolve path refuses `"approved"` for it — reviewing it
   * later can record what the user thinks, and can never turn into permission
   * for a call whose turn is over. A timeout on the queue is therefore not a
   * thing that can happen: the denial has already happened.
   */
  private async deferParentEscalation(input: {
    request: ApprovalRequest;
    childProvenance: ChildAgentProvenance;
    policy: ReviewerParentAdjudicationBlock;
    notice: ParentEscalationNotice;
    verdict: RiskVerdict;
    auditFields: string;
  }): Promise<ApprovalDecision | null> {
    const { request, childProvenance, policy, notice } = input;
    if (policy.backgroundEscalation !== "deferred") return null;
    // Host facts only, and deliberately narrow. A background run whose window
    // nobody can see is one case; a desk the user armed the away answerer
    // before leaving is the other. The background flag ALONE is not enough —
    // every locally spawned child is a background run on this host, so keying
    // on it would take the dock away from a user who is sitting right there.
    const unattended =
      this.awayAuthority.snapshot() !== null ||
      (childProvenance.background === true && !this.deskAttended());
    if (!unattended) return null;
    const queue = this.parentAdjudication?.deferredQueue?.();
    if (!queue) return null;
    // A queue row states what the call was. Neither field is defaulted here —
    // an entry that called an unknown source "builtin" or an unknown category
    // "read" would be a record of a call that did not happen, and the honest
    // answer for an ask the host cannot describe is the dock it would have
    // painted anyway.
    const { source, toolCategory } = request;
    if (source === undefined || toolCategory === undefined) return null;

    const sessionId = request.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID;
    const pairKey = canonicalStringify([
      childProvenance.childSessionId,
      request.toolName,
    ]);
    const alreadyQueued = this.deferredEscalationEntries.get(pairKey);
    if (alreadyQueued !== undefined) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "approval",
        output: `[approval:parent-escalation-deferred] ${request.id} ${input.auditFields} deferredId=${auditSafeText(alreadyQueued)} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} cause=${notice.cause} coalesced=true → deny-once`,
      });
      const repeat = markHostApprovalRejectedDecision({
        requestId: request.id,
        choice: "deny-once",
      });
      deferredEscalatedDecisions.set(repeat, {
        cause: notice.cause,
        deferredId: alreadyQueued,
      });
      return repeat;
    }
    let deferredId: string;
    try {
      deferredId = await queue.append({
        toolName: request.toolName,
        source,
        category: toolCategory,
        // Host-composed and host-owned: the cause, the child's masked title and
        // the masked arguments. The adjudicator's own sentence is deliberately
        // absent — the queue panel has no way to attribute a model's words to
        // the model, and this field is read as a description of the call. It is
        // in the audit row below instead.
        inputSummary: deferredEscalationSummary(request, notice, childProvenance),
        ...(request.evaluationContext === undefined
          ? {}
          : { evaluationContext: request.evaluationContext }),
        verdict: input.verdict,
      });
    } catch {
      return null;
    }

    this.deferredEscalationEntries.set(pairKey, deferredId);
    if (this.deferredEscalationEntries.size > MAX_TRACKED_DEFERRED_PAIRS) {
      const oldest = this.deferredEscalationEntries.keys().next();
      if (!oldest.done) this.deferredEscalationEntries.delete(oldest.value);
    }
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId,
      type: "approval",
      output: `[approval:parent-escalation-deferred] ${request.id} ${input.auditFields} deferredId=${auditSafeText(deferredId)} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} cause=${notice.cause} reason=${auditSafeText(notice.reason)} → deny-once`,
    });
    try {
      this.notificationService?.fire({
        kind: "approval",
        title: t("be_approvalGate.notificationTitle"),
        body: t("be_approvalGate.deferredEscalationBody", {
          name: request.toolName,
        }),
        contextRef: { approvalId: request.id },
        urgent: true,
      });
    } catch {
      // A notification that failed must not un-record the queue entry.
    }
    const decision = markHostApprovalRejectedDecision({
      requestId: request.id,
      choice: "deny-once",
    });
    deferredEscalatedDecisions.set(decision, {
      cause: notice.cause,
      deferredId,
    });
    return decision;
  }

  /**
   * Await the parent's answer, but no longer than the turn behind it lasts.
   *
   * The adjudicator is handed the abort signal and a well-behaved provider
   * ends its call on it, but "well-behaved" is an assumption about code this
   * gate does not own. Watching the signal here makes the bound structural:
   * whatever the adapter does with it, a stopped turn stops waiting.
   */
  private async adjudicateWithin(
    deps: ParentAdjudicationGateDeps,
    modelSource: ParentAdjudicationModelSource,
    evidence: ParentAdjudicationEvidence,
    options: ParentAdjudicationOptions,
  ): Promise<ParentAdjudicationResult> {
    const answer = deps.adjudicator(modelSource).adjudicate(evidence, options);
    const signal = options.abortSignal;
    if (signal === undefined) return answer;
    if (signal.aborted) {
      // Nothing will fire a listener for an abort that already happened.
      void answer.catch(() => undefined);
      return {
        outcome: "escalate",
        cause: "turn-aborted",
        reason: "the turn was stopped",
      };
    }
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<ParentAdjudicationResult>((resolve) => {
      onAbort = (): void =>
        resolve({
          outcome: "escalate",
          cause: "turn-aborted",
          reason: "the turn was stopped",
        });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([answer, stopped]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      // The losing side of the race still settles. Without this, an
      // adjudication that rejects after the abort won is an unhandled
      // rejection, which this process treats as fatal.
      void answer.catch(() => undefined);
    }
  }

  /**
   * Ask the parent, and turn its answer into what happens to this ask. Reached
   * only through {@link parentAdjudicationLane}, which is what decided that
   * asking is permitted at all.
   *
   * Its only non-escalating answers are one allow-once and one deny-once,
   * neither carrying a `rememberPattern`: a parent may decide one call and may
   * not mint a rule that outlives it. Everything else — a timeout, a spent
   * budget, an unparseable answer, a missing adjudicator, a thrown provider, an
   * explicit "I cannot tell", or one denial too many — ends at the user's dock
   * carrying a {@link ParentEscalationNotice}, so the user is told that a stage
   * they never saw has already run.
   */
  private async askParent(
    lane: {
      deps: ParentAdjudicationGateDeps;
      policy: ReviewerParentAdjudicationBlock;
      verdict: RiskVerdict;
    },
    input: {
      request: ApprovalRequest;
      childProvenance: ChildAgentProvenance;
      abortSignal?: AbortSignal;
      /** Pre-rendered audit fields for this request. */
      auditFields: string;
    },
  ): Promise<ParentAdjudicationStageOutcome> {
    const { request, childProvenance } = input;
    const { deps, policy, verdict } = lane;
    const sessionId = request.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID;
    const logRow = (row: string): void => {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "approval",
        output: row,
      });
    };

    const detections = new Set<string>();
    let result: ParentAdjudicationResult;
    try {
      // Host-composed evidence only. The masking is the same display masking
      // the dock gets, so the parent cannot be shown a secret the user would
      // not have been shown, and no prose a child wrote is in it.
      //
      // Composed INSIDE the try, not before it. Masking walks a structure the
      // child chose the shape of, and a throw out of that walk would reject
      // this method, reject `requestAndWait`, and surface as a tool error —
      // the one failure of this lane that would never reach the dock.
      const evidence: ParentAdjudicationEvidence = {
        toolName: request.toolName,
        ...(request.toolCategory === undefined
          ? {}
          : { toolCategory: request.toolCategory }),
        ...(request.source === undefined ? {} : { source: request.source }),
        maskedArgs: maskArgsForDisplay(
          boundedEvidenceArgs(request.args),
          detections,
        ),
        verdict,
        ...(request.target?.filePath === undefined
          ? {}
          : {
              targetFilePath: maskArgsForDisplay(
                request.target.filePath,
                detections,
              ) as string,
            }),
        // The scope the permission decision actually used, when the pipeline
        // captured one. An empty list is weaker evidence, never a wider one.
        allowedDirectories: request.evaluationContext?.allowedDirectories ?? [],
        child: {
          childSessionId: childProvenance.childSessionId,
          childTitle: childProvenance.childTitle,
          spawnTaskSummary: childProvenance.spawnTaskSummary,
        },
        // Host-composed, and the one fact about this ask the parent cannot
        // otherwise see: a sibling's message is what prompted the call. It is
        // already the leading segment of the `reason` the dock would have
        // shown, so a parent-answered ask is the ONLY lane where omitting it
        // hides something the human path displays.
        ...(request.approvalReasonPrefix === undefined
          ? {}
          : { a2aInfluenceLabel: request.approvalReasonPrefix }),
        ...this.parentContextBlock(policy, childProvenance.originSessionId),
      };
      if (detections.size > 0) {
        // The dock path writes this row when it masks a payload; a
        // parent-answered ask never reaches that path, and an ask whose
        // arguments held credentials must not be the one class of ask with no
        // record that masking happened — especially since this payload leaves
        // the machine.
        logRow(
          `[approval:args-dlp-masked] ${request.id} toolName=${request.toolName} lane=parent-adjudication detections=${[...detections].join(",")}`,
        );
      }
      result = await this.adjudicateWithin(deps, policy.model, evidence, {
        parentSessionId: childProvenance.originSessionId,
        timeoutMs: policy.timeoutMs,
        maxPerChildRun: policy.maxPerChildRun,
        ...(input.abortSignal === undefined
          ? {}
          : { abortSignal: input.abortSignal }),
      });
    } catch {
      // A throwing adjudicator is a broken adjudicator, and this lane's whole
      // contract is that nothing about it can produce an allow. Caught rather
      // than propagated because an exception out of here would abandon the
      // ask entirely — the user would never be offered the call at all.
      result = {
        outcome: "escalate",
        cause: "llm-error",
        reason: "the adjudication call failed",
      };
    }

    if (result.outcome === "allow-once") {
      this.clearParentDenialStreak(
        childProvenance.childSessionId,
        request.toolName,
      );
      logRow(
        `[approval:parent-adjudicated] ${request.id} ${input.auditFields} answeredBy=${approvalAnswererAuditToken("parent-agent")} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} reason=${auditSafeText(result.reason)} → allow-once`,
      );
      // No pending entry is ever created for this ask, so there is nothing for
      // `resolve` to bind a later choice to and nothing for a user-approval
      // record to be minted from. No `rememberPattern` either — the away
      // answer sets none for the same reason, and its only consumers persist
      // it as a durable rule.
      return {
        kind: "answered",
        decision: markParentAdjudicatedDecision(
          { requestId: request.id, choice: "allow-once" },
          { outcome: "allow-once", reason: result.reason },
        ),
      };
    }

    if (result.outcome === "deny") {
      const streak = this.recordParentDenial(
        childProvenance.childSessionId,
        request.toolName,
      );
      if (streak < PARENT_DENIAL_ESCALATION_THRESHOLD) {
        logRow(
          `[approval:parent-adjudicated] ${request.id} ${input.auditFields} answeredBy=${approvalAnswererAuditToken("parent-agent")} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} streak=${streak} reason=${auditSafeText(result.reason)} → deny-once`,
        );
        // Deliberately no `rememberPattern`: a parent that could set one
        // would be minting a durable deny rule for a user who never saw the
        // request. Its reason travels on the host-only provenance map, which
        // a renderer cannot read or write.
        return {
          kind: "answered",
          decision: markParentAdjudicatedDecision(
            { requestId: request.id, choice: "deny-once" },
            { outcome: "deny", reason: result.reason },
          ),
        };
      }
      // The streak is cleared as it escalates, so the user is asked once per
      // run of denials rather than for every ask from here on.
      this.clearParentDenialStreak(
        childProvenance.childSessionId,
        request.toolName,
      );
      logRow(
        `[approval:parent-escalated] ${request.id} ${input.auditFields} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} cause=repeated-denial streak=${streak} reason=${auditSafeText(result.reason)}`,
      );
      return {
        kind: "escalate",
        notice: {
          cause: "repeated-denial",
          reason: result.reason,
          childTitle: displaySafeChildTitle(childProvenance.childTitle),
        },
      };
    }

    logRow(
      `[approval:parent-escalated] ${request.id} ${input.auditFields} child=${auditSafeText(childProvenance.childSessionId)} parent=${auditSafeText(childProvenance.originSessionId)} cause=${result.cause} reason=${auditSafeText(result.reason)}`,
    );
    return {
      kind: "escalate",
      notice: {
        cause: result.cause,
        reason: result.reason,
        childTitle: displaySafeChildTitle(childProvenance.childTitle),
      },
    };
  }

  /**
   * Send an approval request to the renderer and wait for the response.
   * ConversationLoop.executeOne() awaits this and blocks the turn.
   * The requireExplicit field controls renderer dismiss behavior.
   */
  async requestAndWait(req: ApprovalRequestInput): Promise<ApprovalDecision> {
    const {
      forceExplicit = false,
      durableApprovalRecordAllowed: requestedDurableApprovalRecordAllowed,
      hostShellExecutionPermitBinding,
      executionPlan: requestedExecutionPlan,
      sandboxCapability: requestedSandboxCapability,
      remoteControllerOrigin,
      remoteControllerAuthority,
      scopeTargetFilePaths,
      abortSignal,
      childProvenance,
      parentAdjudicationEligible,
      ...request
    } = req;
    // Do not forward the host-only binding to renderer or audit payloads.
    // Audit receives only its allowlist execution-plan projection.
    //
    // `remoteControllerOrigin` and `remoteControllerAuthority` are destructured
    // out for the same reason: the renderer payload is built by spreading the
    // request, so a host-only field left on it would be sent. Every audit row
    // this method writes still states the origin, injected here in one place
    // rather than at each row — a row that forgot it would read as
    // desk-originated, which is the claim a reviewer must not have to
    // second-guess. The authority object is never audited at all: it carries a
    // live guard closure, and a row's job is to state the fact, not to hold the
    // capability that decided it. `abortSignal` is destructured out for the
    // first of those reasons and one more: it is a live object carrying a
    // listener list, and the renderer payload crosses a structured clone.
    //
    // `childProvenance` and `parentAdjudicationEligible` are destructured out
    // here for the first reason, and the destructuring is the whole mechanism:
    // they are inputs to a host-internal decision, and a renderer that received
    // them could report which asks the host is about to route away from the
    // dock. The tier-2 stage below reads both from these locals; neither is
    // ever on `request`, so no later spread can put them back on the payload.
    const auditFieldsFor = (
      fields: ApprovalAuditFields,
      executionPlan?: HostShellExecutionPlanAuditProjection,
    ): string =>
      formatApprovalAuditFields(
        { ...fields, remoteControllerOrigin },
        executionPlan,
      );
    const rationaleDisplay = parseValidRationaleApprovalDisplay(req);

    // Rationale is a host-owned, one-shot approval surface. Validate its
    // narrow explanatory card before any enrichment, notification, nonce
    // minting, or renderer IPC so a malformed/mismatched request cannot turn
    // into a clickable approval dock.
    if (req.kind === "rationale" && rationaleDisplay === null) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:rationale-display-invalid] ${req.id} ${auditFieldsFor(req)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
    }

    const suppliedExecutionPlan = requestedExecutionPlan === undefined
      ? undefined
      : isIssuedHostShellExecutionPlanAuditProjection(requestedExecutionPlan)
        ? requestedExecutionPlan
        : undefined;
    if (requestedExecutionPlan !== undefined && suppliedExecutionPlan === undefined) {
      // Never copy a structural lookalike into an IPC payload or an audit row:
      // even additional fields on an otherwise plausible object could leak the
      // private Plan-B binding/action context.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:execution-plan-invalid] ${req.id} ${auditFieldsFor(request)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "execution plan projection was not issued by the host",
      });
    }

    const requestedChoices = req.allowedChoices;
    const verdictAtApproval = resolveUserApprovalVerdict(req);
    const highRiskOneShot = verdictAtApproval === "high";
    const hasOneShotApprovalChoiceContract =
      requestedChoices?.length === 2 &&
      requestedChoices.includes("allow-once") &&
      requestedChoices.includes("deny-once");
    // Exact one-shot requests and rationale prompts are never eligible for a
    // durable user-approval record.  Treat this as an invariant instead of a
    // caller preference: a future emitter must not be able to widen a
    // per-invocation decision by setting the host-only option to `true`.
    const durableApprovalRecordAllowed =
      req.kind !== "rationale" &&
      !hasOneShotApprovalChoiceContract &&
      requestedDurableApprovalRecordAllowed !== false;
    const hasOneShotHostShellApprovalContract =
      forceExplicit === true &&
      hasOneShotApprovalChoiceContract;
    if (
      hostShellExecutionPermitBinding !== undefined &&
      (
        !hasOneShotHostShellApprovalContract ||
        !matchesHostShellExecutionPermitBindingRequest(
          request,
          hostShellExecutionPermitBinding,
        )
      )
    ) {
      // Do not expose the host-only binding to the renderer, and do not retain
      // it in pending state. A UI request that differs from the bound plain
      // spawn must never mint a receipt, even after an authenticated response.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:host-shell-binding-mismatch] ${req.id} ${auditFieldsFor(request)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "host shell approval binding did not match displayed request",
      });
    }
    const oneShotPermitBinding =
      hostShellExecutionPermitBinding !== undefined &&
      hasOneShotHostShellApprovalContract
        ? Object.freeze({
            ...hostShellExecutionPermitBinding,
            allowedDirectories: Object.freeze([...hostShellExecutionPermitBinding.allowedDirectories]),
          })
        : undefined;
    const boundExecutionPlan = oneShotPermitBinding === undefined
      ? undefined
      : getHostShellExecutionPlanAuditProjection(oneShotPermitBinding.plan);
    if (
      boundExecutionPlan !== undefined &&
      suppliedExecutionPlan !== undefined &&
      suppliedExecutionPlan !== boundExecutionPlan
    ) {
      // A Plan-B display must describe the exact host-sealed plan behind the
      // hidden permit. Do not allow a second, even host-issued, projection to
      // make the user approve a different substrate.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:execution-plan-mismatch] ${req.id} ${auditFieldsFor(request, boundExecutionPlan)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "execution plan did not match the host shell binding",
      });
    }
    const executionPlanAudit = boundExecutionPlan ?? suppliedExecutionPlan;

    // Sandbox capability injection is scoped to the
    // tool-execution approval surface. Non-execution surfaces
    // (out-of-allowed-dir directory confirm, agent-action/mode-change
    // config asks)
    // have no sandbox row in their DOM and showing "isolation: none" on a
    // config change is misleading because no tool will run.
    //
    // The injection guard checks BOTH `kind` AND `toolCategory`:
    //   - `kind === "out-of-allowed-dir"`        → no injection
    //   - `kind === "agent-action"`              → no injection
    //   - `toolCategory === "meta"`              → no injection
    //                                              (catches mode-change
    //                                              asks that default
    //                                              `kind` to "tool")
    //   - else (tool execution)                  → inject
    //
    // Caller-supplied capability is always preserved (`??` semantics).
    const isExecutionKind =
      (req.kind === undefined ||
        req.kind === "tool" ||
        req.kind === "rationale") &&
      req.toolCategory !== "meta";
    const fullReq: ApprovalRequest = {
      ...request,
      ...(executionPlanAudit === undefined
        ? {}
        : { executionPlan: executionPlanAudit }),
      // Rationale's generic reason is deliberately not caller-controlled.
      // Set this before all downstream handling, including audit, OS
      // notification, HMAC sealing, pending state, and renderer narrowing.
      reason:
        req.kind === "rationale" && rationaleDisplay !== null
          ? RATIONALE_HOST_OWNED_REASON
          : req.reason,
      // A sealed execution plan is the only renderer-safe authority
      // description for canonical host shells. Its projection deliberately
      // excludes the host capability's free-form reason, so never retain or
      // inject the raw capability alongside it.
      ...(executionPlanAudit === undefined
        ? {
            // Substrate-aware fallback: the gate does not get to answer the
            // isolation question itself. `resolveReviewerSandboxCapability` is
            // the authority the executor lane already uses, and it carries the
            // NO-LEAK INVARIANT — never report `asrt` for a worker this process
            // did not wrap. A process-global probe cannot honour that: it would
            // claim host-shell ASRT confinement for a plugin/MCP call that runs
            // in an unwrapped long-lived worker.
            //
            // `source` omitted ⇒ the substrate is unknown ⇒ no row, rather than
            // a guessed one (fail closed; never fall back to "builtin", whose
            // canonical-shell branch can legitimately report `asrt`).
            sandboxCapability:
              requestedSandboxCapability ??
              (isExecutionKind && req.source !== undefined
                ? resolveReviewerSandboxCapability(req.source, req.toolName)
                : undefined),
          }
        : {}),
      allowedChoices:
        req.kind === "rationale" || highRiskOneShot
          ? ["allow-once", "deny-once"]
          : req.allowedChoices,
      requireExplicit:
        req.kind === "rationale"
          ? true
          : forceExplicit || this.currentPolicy.requireExplicitApproval,
    };

    // §S1: sensitive-path hard-block — runs BEFORE anything else so that
    // not even full_auto / user-approval paths can bypass it. Cannot be
    // overridden by user approval, admin policy, or permission mode.
    //
    // Canonicalize the path BEFORE matching via the shared
    // canonicalizePathForMatch() helper. This closes four bypass vectors:
    // `..` segments, NFD unicode forms, trailing spaces, mixed-case on
    // case-insensitive filesystems, and duplicate slashes.
    const rawCandidate = fullReq.target?.filePath;
    if (rawCandidate) {
      const caseFolded = canonicalizePathForMatch(rawCandidate);
      const matchedPattern = isSensitivePath(caseFolded);
      if (matchedPattern) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:sensitive-path-blocked] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} raw=${rawCandidate} canonical=${caseFolded} pattern=${matchedPattern} → deny-once (hard-block)`,
        });
        return markHostApprovalRejectedDecision({
          requestId: fullReq.id,
          choice: "deny-once",
          rememberPattern: `Sensitive credential path blocked: ${matchedPattern}`,
        });
      }
    }

    // §S4: isReadOnly short-circuit — if the tool self-declares read-only
    // and we are NOT in plan mode, skip the approval dock. Plan
    // mode still blocks (plan = dry-run / inspect only).
    //
    // Permission policy P2.5: directory-confirm requests (kind="out-of-allowed-dir")
    // MUST NOT auto-approve via §S4 — even a read of an out-of-allowed
    // path is a scope-grant decision the user has to make explicitly.
    if (
      fullReq.isReadOnly === true &&
      fullReq.mode !== "ask_all" &&
      fullReq.mode !== "plan" &&
      fullReq.kind !== "out-of-allowed-dir" &&
      fullReq.kind !== "agent-action" &&
      fullReq.kind !== "rationale"
    ) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:read-only-auto-approve] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} mode=${fullReq.mode ?? "default"} → allow-once`,
      });
      return {
        requestId: fullReq.id,
        choice: "allow-once",
        rememberPattern: "read-only auto-approve",
      };
    }

    // §A2: webContents destruction check — deny once if the renderer is already closed.
    if (this.webContents.isDestroyed()) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:send-failed] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} — webContents already destroyed → deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: fullReq.id,
        choice: "deny-once",
      });
    }

    // §S8 phase: requested
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      // Emit provenance fields needed to distinguish a host tool ask from a
      // plugin-origin agent-action request during incident replay.
      input: `[approval:requested] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)}`,
    });

    // ─── Turn abort ──────────────────────────────────
    //
    // One construction of the answer to "the turn behind this ask is over",
    // shared by the already-aborted check just below and by the listener that
    // covers an abort arriving while the request is parked. The row reuses the
    // `[approval:cancelled]` marker the rationale cancel path already writes:
    // to a reviewer both are the host retiring a request nobody answered, and
    // `reason=` is what separates them.
    //
    // deny-once, and host-rejected rather than a deny the user authored — it
    // is the fail-closed answer, and a stopped turn must not be readable as
    // the owner refusing this particular call. No `rememberPattern`: the
    // timeout, the other outcome the host reaches on its own, sets none, and
    // that field's only consumers persist it as an allow/deny rule.
    const denyForAbortedTurn = (): ApprovalDecision => {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:cancelled] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} reason=turn-abort → deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: fullReq.id,
        choice: "deny-once",
      });
    };
    // Above the away answer, the OS notification and the renderer send, all
    // for one reason: none of them should happen on behalf of a turn that is
    // already over. An away grant in particular has a finite budget, and
    // spending a unit of it to answer a dead turn spends it on nothing.
    if (abortSignal?.aborted) return denyForAbortedTurn();

    // ─── Away Authority ──────────────────────────────
    //
    // The desk-armed second answerer. Its position is load-bearing: everything
    // above it has already run and none of it is reachable from here. In
    // particular the sensitive-path hard block, the host-shell binding match,
    // the execution-plan mismatch check, the rationale-display validation and
    // the destroyed-window deny have all either returned or passed, so an away
    // answer cannot re-open any of them. It sits below the `[approval:requested]`
    // row so every away-answered call has a requested row too, and above the OS
    // notification and the renderer send so a call it answers never rings a
    // phone or paints a foreground dock nobody is there to see.
    //
    // It reads only the request and its own grant. No inbound message reaches
    // this decision, which is the entire difference between this and a relay.
    const away = this.awayAuthority.consume(
      {
        remoteControllerOrigin,
        remoteControllerAuthority,
        sessionId: fullReq.sessionId,
        // The request's own field, strictly. Deliberately not
        // `getRequestSnapshot`, which defaults a missing source to "builtin".
        source: fullReq.source,
        kind: fullReq.kind,
        category: fullReq.category,
        toolCategory: fullReq.toolCategory,
        allowedChoices: fullReq.allowedChoices,
        // The gate's derived value, not the caller's requested one.
        durableApprovalRecordAllowed,
        hostShellExecutionPermitBound:
          hostShellExecutionPermitBinding !== undefined,
        // The full set, not `target.filePath` — that is the display value and
        // is only the first extracted path.
        targetFilePaths: scopeTargetFilePaths ?? [],
      } satisfies AwayAuthorityCandidate,
      Date.now(),
    );
    if (away.answer) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:away-answered] ${fullReq.id} ${auditFieldsFor({ ...fullReq, answeredBy: "away-authority" }, executionPlanAudit)} remaining=${away.remaining} → allow-once`,
      });
      if (away.remaining === 0) {
        // The grant retired itself spending its last unit. Said here because
        // this is the only moment it can be said: from the next call on there
        // is no grant left to explain why the away answers stopped.
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:away-retired] reason=budget-spent`,
        });
      }
      // Returning here is what makes the answer one-shot in the strongest
      // available sense: no pending entry is created, so there is nothing for
      // `resolve` to accept a later choice against and nothing for
      // `getRequestSnapshot` to bind a user-approval record to.
      //
      // No `rememberPattern` either. Its only consumers persist it as an
      // allow/deny pattern, and this answer must leave nothing behind.
      return { requestId: fullReq.id, choice: "allow-once" };
    }
    if (away.reportable) {
      // An armed grant saw a paired-platform ask and did not answer it. The
      // call now falls through to a desk nobody is at, so without this row the
      // only trace would be a timeout with no stated cause.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:away-declined] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} reason=${away.refusal}`,
      });
    }

    // ─── Tier 2: parent adjudication ─────────────────
    //
    // Its position mirrors the away answerer's above it and is load-bearing
    // for the same reason: every hard check has already run, so a parent
    // answer cannot re-open one, and it sits above the OS notification and
    // the renderer send so a call it answers never rings a phone or paints a
    // dock. It runs only for asks that carry host-set child provenance, which
    // is a fact no renderer and no child can author.
    let parentEscalation: ParentEscalationNotice | undefined;
    const parentLane =
      childProvenance === undefined
        ? null
        : this.parentAdjudicationLane({
            request: fullReq,
            callerEligible: parentAdjudicationEligible === true,
            forceExplicit,
            oneShotPermitBound: oneShotPermitBinding !== undefined,
            highRiskOneShot,
            ...(remoteControllerOrigin === undefined
              ? {}
              : { remoteControllerOrigin }),
          });
    if (parentLane !== null && childProvenance !== undefined) {
      const stage = await this.askParent(parentLane, {
        request: fullReq,
        childProvenance,
        ...(abortSignal === undefined ? {} : { abortSignal }),
        auditFields: auditFieldsFor(fullReq, executionPlanAudit),
      });
      // The stage awaits a model call, and the turn behind this ask can end
      // during it. Checked before the outcome is honoured, and before the
      // pending entry that the abort listener would otherwise cover exists:
      // an abort that arrives in this window has no listener to fire, so
      // without this check a stopped turn would sit on the dock until the
      // five-minute timeout.
      if (abortSignal?.aborted) return denyForAbortedTurn();
      if (stage.kind === "answered") return stage.decision;
      if (stage.kind === "escalate") {
        // Tier 3, for a run nobody is watching. Returns null — and falls
        // through to the dock below — whenever the route does not apply or
        // could not record the ask.
        const deferred = await this.deferParentEscalation({
          request: fullReq,
          childProvenance,
          policy: parentLane.policy,
          notice: stage.notice,
          verdict: parentLane.verdict,
          auditFields: auditFieldsFor(fullReq, executionPlanAudit),
        });
        if (deferred !== null) return deferred;
        parentEscalation = stage.notice;
      }
    }

    // Issue #260 — surface a system notification when an approval is about
    // to block the user. Approval is the most user-visible gate; default to
    // urgent so the OS toast plays sound even when window is backgrounded.
    try {
      this.notificationService?.fire({
        kind: "approval",
        title: t("be_approvalGate.notificationTitle"),
        body: `${fullReq.toolName}: ${fullReq.reason}`,
        contextRef: { approvalId: fullReq.id },
        urgent: true,
      });
    } catch {
      // notification failure must never block approval flow
    }

    // Mint nonce + HMAC, attach to outgoing request (confused-deputy defense)
    const nonce = randomBytes(16).toString("hex");
    const expectedHmac = signApprovalRequest(this.sessionKey, {
      id: fullReq.id,
      nonce,
      toolName: fullReq.toolName,
      sessionId: fullReq.sessionId,
      args: fullReq.args,
    });
    const signedReq: ApprovalRequest = {
      ...fullReq,
      // Added after the preimage above rather than before it, deliberately.
      // The signature authenticates what the renderer echoes back, and this
      // field is outbound-only — see its declaration.
      ...(parentEscalation === undefined ? {} : { parentEscalation }),
      nonce,
      hmac: expectedHmac,
    };

    return new Promise<ApprovalDecision>((resolve, reject) => {
      // One teardown authority for every way this request can end. `settle` is
      // what the pending entry stores, so the renderer answer, the timeout,
      // the rationale cancel and the shutdown sweep each detach the abort
      // listener without any of them having to know it exists. Otherwise a
      // turn that asks a hundred times leaves a hundred live listeners on one
      // signal, and `AbortSignal` is an `EventTarget`, which starts warning
      // about exactly that at eleven.
      let detachAbortListener: (() => void) | undefined;
      const settle = (decision: ApprovalDecision): void => {
        detachAbortListener?.();
        detachAbortListener = undefined;
        // Every way a PARKED request ends passes through here — desk answer,
        // remote answer, timeout, turn abort, cancel, shutdown sweep — so this
        // is the one place an observer's card can be told the request is no
        // longer answerable.
        this.notifyPendingSettled(fullReq.id, decision);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        this.pending.delete(fullReq.id);
        // Timeout: handle as deny-once for fail-safe behavior.
        // §S8 phase: timeout
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:timeout] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} → deny-once`,
        });
        const timeoutDecision: ApprovalDecision = {
          requestId: fullReq.id,
          choice: "deny-once",
        };
        hostTimeoutDecisions.add(timeoutDecision);
        settle(timeoutDecision);
      }, this.timeoutMs);

      if (abortSignal !== undefined) {
        const onAbort = (): void => {
          clearTimeout(timer);
          // Drop the entry before resolving, so a renderer answer that crossed
          // the abort in flight arrives as a harmless unknown-request replay
          // instead of an answer to a turn that no longer exists.
          this.pending.delete(fullReq.id);
          settle(denyForAbortedTurn());
        };
        detachAbortListener = () =>
          abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(fullReq.id, {
        resolve: settle,
        reject,
        timer,
        trustOrigin: fullReq.trustOrigin ?? "unknown",
        sessionId: fullReq.sessionId,
        // Carried from the request, not re-derived: the pending entry outlives
        // the request object and is the only copy the decided/timeout/cancelled
        // rows can read.
        remoteControllerOrigin,
        toolName: fullReq.toolName,
        args: fullReq.args,
        category: fullReq.category,
        kind: fullReq.kind,
        allowedChoices: fullReq.allowedChoices,
        toolCategory: fullReq.toolCategory,
        verdictAtApproval,
        source: fullReq.source,
        sourcePluginId: fullReq.sourcePluginId,
        approvalScope: fullReq.approvalScope,
        ...(fullReq.outOfAllowedDir === undefined
          ? {}
          : {
              outOfAllowedDir: {
                candidatePath: fullReq.outOfAllowedDir.candidatePath,
                suggestedParent: fullReq.outOfAllowedDir.suggestedParent,
              },
            }),
        approvalCacheKey: fullReq.approvalCacheKey,
        durableApprovalRecordAllowed,
        ...(executionPlanAudit === undefined
          ? {}
          : { executionPlan: executionPlanAudit }),
        ...(oneShotPermitBinding !== undefined
          ? { hostShellExecutionPermitBinding: oneShotPermitBinding }
          : {}),
        nonce,
        expectedHmac,
      });

      // Announce the parked request to host-internal observers. Positioned
      // after `pending.set` so an observer's answer through `resolve()` finds
      // the entry, and below every host-only short circuit above (which all
      // returned before a pending entry existed).
      this.notifyPendingParked({
        requestId: fullReq.id,
        toolName: fullReq.toolName,
        ...(fullReq.source === undefined ? {} : { source: fullReq.source }),
        category: fullReq.category,
        ...(fullReq.kind === undefined ? {} : { kind: fullReq.kind }),
        ...(fullReq.allowedChoices === undefined
          ? {}
          : { allowedChoices: fullReq.allowedChoices }),
        ...(fullReq.sessionId === undefined
          ? {}
          : { sessionId: fullReq.sessionId }),
        nonce,
        hmac: expectedHmac,
      });

      // Send the request to the renderer (main→renderer one-way).
      // Mask sensitive args for display; the original args stay inside the executor
      // and are still used for tool execution.
      // Attach nonce+hmac to the masked payload for confused-deputy defense.
      const dlpHits = new Set<string>();
      // Sealing is total by construction (the closing constructor throws rather
      // than emitting an unparseable display), so this throw path should be
      // unreachable — but an unreachable throw that would strand the pending
      // entry until timeout is still a liveness hole. Mirror the send-failure
      // branch below: clear pending, audit, deny once.
      let maskedSignedReq: ApprovalRequest;
      try {
        maskedSignedReq =
        fullReq.kind === "rationale" && rationaleDisplay !== null
          ? createRendererSafeRationaleApprovalRequest(
              signedReq,
              rationaleDisplay,
              dlpHits,
            )
          : {
              ...signedReq,
              args: maskArgsForDisplay(fullReq.args, dlpHits),
              ...(signedReq.approvalPurpose
                ? {
                    approvalPurpose: maskApprovalPurposeForDisplay(
                      signedReq.approvalPurpose,
                      dlpHits,
                    ),
                  }
                : {}),
            };
      } catch (sealErr) {
        clearTimeout(timer);
        this.pending.delete(fullReq.id);
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:seal-failed] ${fullReq.id} toolName=${fullReq.toolName} error=${sealErr instanceof Error ? sealErr.message : String(sealErr)} → deny-once`,
        });
        settle(
          markHostApprovalRejectedDecision({
            requestId: fullReq.id,
            choice: "deny-once",
          }),
        );
        return;
      }
      if (dlpHits.size > 0) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:args-dlp-masked] ${fullReq.id} toolName=${fullReq.toolName} trustOrigin=${fullReq.trustOrigin ?? "unknown"} detections=${[...dlpHits].join(",")}`,
        });
      }
      // §F2: on send failure (webContents destruction race), clear pending and deny once.
      try {
        this.webContents.send(IPC_APPROVAL_REQUEST, maskedSignedReq);
      } catch (sendErr) {
        clearTimeout(timer);
        this.pending.delete(fullReq.id);
        // §S8 phase: send-failed
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:send-failed] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} error=${sendErr instanceof Error ? sendErr.message : String(sendErr)} → deny-once`,
        });
        settle(
          markHostApprovalRejectedDecision({
            requestId: fullReq.id,
            choice: "deny-once",
          }),
        );
      }
    });
  }

  /**
   * Called by the IPC handler when the renderer responds.
   * Ignores unknown pending entries, making duplicate responses safe.
   *
   * `answeredBy` is host-derived AT THE CALL SITE, never read from the
   * decision payload: the renderer's IPC route and the plugin host-API route
   * omit it and stay `desk`; the paired chat-platform card handler is the one
   * caller that passes `"platform-bridge"`. Every answerer passes the same
   * integrity and allowed-choice checks below — there is deliberately no
   * second resolution path.
   */
  resolve(
    requestId: string,
    decision: ApprovalDecision,
    answeredBy: ApprovalAnswerer = "desk",
  ): ApprovalDecision | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;

    // Confused-deputy defense — verify nonce + HMAC BEFORE honoring the
    // decision. A mismatch indicates either a malicious/compromised renderer,
    // a replay of a stale decision, or a cross-request mix-up. Force
    // deny-once and audit the failure.
    if (!verifyApprovalIntegrity(entry, decision)) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:nonce-mismatch] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} choice=${decision.choice} nonceProvided=${decision.nonce ? "yes" : "no"} hmacProvided=${decision.hmac ? "yes" : "no"} → deny-once (forced)`,
      });
      const forcedDecision: ApprovalDecision = {
        requestId,
        choice: "deny-once",
        rememberPattern: "approval integrity check failed",
      };
      hostRejectedApprovalDecisions.add(forcedDecision);
      entry.resolve(forcedDecision);
      return forcedDecision;
    }

    if (
      entry.allowedChoices &&
      !entry.allowedChoices.includes(decision.choice)
    ) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:choice-not-allowed] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} choice=${decision.choice} allowed=${entry.allowedChoices.join(",")} → deny-once (forced)`,
      });
      const forcedDecision: ApprovalDecision = {
        requestId,
        choice: "deny-once",
        rememberPattern: "approval choice not allowed",
      };
      hostRejectedApprovalDecisions.add(forcedDecision);
      entry.resolve(forcedDecision);
      return forcedDecision;
    }
    // A rationale response is a sealed, one-shot verdict. Do not pass any
    // renderer-provided auxiliary text or structured content to audit or the
    // caller after the authenticated choice has been accepted.
    const resolvedDecision: ApprovalDecision =
      entry.kind === "rationale"
        ? {
            requestId,
            choice: decision.choice,
            nonce: decision.nonce,
            hmac: decision.hmac,
          }
        : decision;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (
      entry.hostShellExecutionPermitBinding !== undefined &&
      resolvedDecision.choice === "allow-once"
    ) {
      hostApprovedOneShotExecutionBindings.set(
        resolvedDecision,
        entry.hostShellExecutionPermitBinding,
      );
    }
    // §S8 phase: decided
    //
    // `answeredBy` is host-derived: it is the parameter this method's caller
    // fixed and never read from `decision`, so a renderer that adds an
    // `answeredBy` field to its response payload cannot reach this row. The
    // `lvis:approval:respond` IPC handler and `hostApi.agentApproval.respond`
    // in the plugin runtime omit it and record `desk`; the paired
    // chat-platform card handler passes `"platform-bridge"`.
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      output: `[approval:decided] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} choice=${resolvedDecision.choice} rememberPattern=${resolvedDecision.rememberPattern ?? "none"}`,
    });
    entry.resolve(resolvedDecision);
    return resolvedDecision;
  }

  /**
   * Fail-closed cancellation boundary for the host-owned rationale flow.
   *
   * This deliberately refuses to cancel ordinary approval requests: callers
   * may retire only the exact pending rationale request they own. Removing the
   * entry before resolving it makes a late renderer response a harmless
   * unknown-request replay.
   */
  cancelPendingRationale(
    requestId: string,
    reason: "caller-abort" | "session-close" = "caller-abort",
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "rationale") return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      output: `[approval:cancelled] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} reason=${reason} → deny-once`,
    });
    entry.resolve(
      markHostApprovalRejectedDecision({
        requestId,
        choice: "deny-once",
        rememberPattern: `rationale approval cancelled: ${reason}`,
      }),
    );
    return true;
  }
  /**
   * Issue #799 — server-side ApprovalRequest snapshot lookup.
   *
   * The userApprovalRecord IPC handler binds to an in-flight request by id
   * and reads the canonical `trustOrigin` / `approvalCacheKey` / `toolName`
   * / `source` from the main-process pending entry rather than trusting
   * the renderer payload. Eliminates the "renderer pretends a different
   * trustOrigin" attack class — a renderer XSS that spoofs
   * `trustOrigin: "user-keyboard"` for an `llm-tool-arg` request can no
   * longer fool the user-approval-store cache identity.
   *
   * Returns `null` when no pending entry exists for `requestId` (e.g. the
   * approval already resolved or timed out).
   */
  getRequestSnapshot(requestId: string): {
    toolName: string;
    args: unknown;
    source: "builtin" | "plugin" | "mcp";
    trustOrigin: string;
    approvalCacheKey: string | undefined;
    durableApprovalRecordAllowed: boolean;
    verdictAtApproval: RiskVerdict["level"];
  } | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind === "rationale") return null;
    return {
      toolName: entry.toolName,
      args: entry.args,
      // PendingEntry.source can be undefined for legacy callers — default
      // to "builtin" so cache identity is conservative (high-trust source).
      // The strict-record handler additionally validates against the SOT
      // emitter; this default never widens an existing approval.
      source: entry.source ?? "builtin",
      trustOrigin: entry.trustOrigin,
      approvalCacheKey: entry.approvalCacheKey,
      durableApprovalRecordAllowed: entry.durableApprovalRecordAllowed,
      verdictAtApproval: entry.verdictAtApproval,
    };
  }

  /**
   * Issue #1940 — the host's own view of a pending out-of-allowed-dir request,
   * for `/allow`.
   *
   * The renderer sends a request id and a sentence. Everything the option
   * table and the selector envelope are built from is read back out of THIS
   * map, so a renderer that lies about a path, a tool name or a set of allowed
   * choices changes nothing: it is describing a request the host resolved.
   *
   * Returns `null` for any other kind, and for a request that already
   * resolved or timed out. `/allow` has no meaning without a live prompt, and
   * a stale id must not produce one.
   */
  getApprovalSentenceState(requestId: string): {
    toolName: string;
    toolCategory: ToolCategory | undefined;
    source: "builtin" | "plugin" | "mcp";
    candidatePath: string;
    suggestedParent: string | null;
    allowedChoices: readonly ApprovalChoice[] | undefined;
  } | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "out-of-allowed-dir") return null;
    if (!entry.outOfAllowedDir) return null;
    return {
      toolName: entry.toolName,
      toolCategory: entry.toolCategory,
      source: entry.source ?? "builtin",
      candidatePath: entry.outOfAllowedDir.candidatePath,
      suggestedParent: entry.outOfAllowedDir.suggestedParent,
      allowedChoices: entry.allowedChoices,
    };
  }

  /** Cleanup: deny every pending request during app shutdown. */
  disposeAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(
        markHostApprovalRejectedDecision({
          requestId: id,
          choice: "deny-once",
        }),
      );
    }
    this.pending.clear();
  }

  /** Current pending request count (for tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Currently active policy (for tests). */
  get policy(): PolicyFile {
    return this.currentPolicy;
  }
}
