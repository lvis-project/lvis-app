import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebContents } from "electron";
import { t } from "../i18n/index.js";
import type { PolicyFile } from "./policy-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { ToolCategory } from "../tools/types.js";
import type { RiskVerdict } from "./reviewer/risk-classifier.js";
import {
  detectSandboxCapability,
  type SandboxCapability,
} from "./sandbox-capability.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import {
  isSensitivePath,
  canonicalizePathForMatch,
} from "./sensitive-paths.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import {
  parseRationaleApprovalDisplay,
  type RationaleApprovalDisplay,
} from "../shared/rationale-approval-display.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";

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

/**
 * Permission mode hint passed alongside an ApprovalRequest. Drives the
 * §S4 isReadOnly short-circuit: in "ask_all" and "plan" modes even
 * read-only tools must still show the approval dialog.
 *
 * `undefined` → treat as "default" (standard read-only auto-approve).
 */
export type ApprovalMode = "default" | "ask_all" | "plan" | "full_auto";

/**
 * Permission policy P2.5 — discriminated kinds for the approval modal.
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
  /** Suggested natural-language purpose shown in the approval dialog. */
  approvalPurpose?: ApprovalPurposeSuggestion;
  args: unknown;
  reason: string;
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
   * Issue #691 round-1 user request — OS-level execution sandbox SOT,
   * surfaced to the approval dialog so the user can see whether the
   * tool will run under the ASRT OS sandbox (macOS Seatbelt / Linux bwrap)
   * or with no isolation. Captured at request build time by the executor
   * (and by {@link ApprovalGate} for non-tool approvals) from
   * {@link detectSandboxCapability}; immutable thereafter.
   *
   * Round-3 code-reviewer MAJOR — typed as the canonical
   * {@link SandboxCapability} (not a structural mirror) to keep the
   * `platform: NodeJS.Platform` enum tight. Mirror declarations in the
   * renderer type SHOULD use the same shape.
   */
  sandboxCapability?: SandboxCapability;
  /**
   * §S1: absolute filesystem path the tool intends to touch. When set and
   * matched against SENSITIVE_PATH_PATTERNS, the request is hard-blocked
   * BEFORE the user dialog is shown. Cannot be overridden.
   */
  target?: {
    filePath?: string;
  };
  /**
   * §S4: tool self-declares it does not mutate state. When true and the
   * current mode is not "plan", the dialog is skipped and the call is
   * auto-approved with reason "read-only auto-approve".
   */
  isReadOnly?: boolean;
  /**
   * §S4: current permission mode. Drives the isReadOnly short-circuit:
   *   - "default" / "full_auto" / undefined → read-only tools auto-approve
   *   - "ask_all" / "plan" → still show the approval dialog
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
   * {@link ApprovalGate.requestAndWait} before any approval dialog is
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
   * Confused-deputy defense — random nonce bound to this request.
   * The renderer MUST echo this value back unchanged in the
   * {@link ApprovalDecision}. Paired with {@link hmac} for integrity.
   */
  nonce?: string;
  /**
   * HMAC-SHA256(sessionKey, `${id}|${nonce}|${toolName}|${canonicalArgs}`)
   * — hex encoded. The main process re-derives this from the stored pending
   * entry on receipt of the decision and rejects on mismatch.
   */
  hmac?: string;
}

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

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Permission origin captured with the approval prompt. */
  trustOrigin: string;
  toolName: string;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  allowedChoices?: readonly ApprovalChoice[];
  toolCategory?: ToolCategory;
  source?: "builtin" | "plugin" | "mcp";
  sourcePluginId?: string;
  approvalScope?: string;
  /**
   * Issue #799 — approval cache key captured server-side at request emit
   * time. The userApprovalRecord IPC handler reads this via
   * {@link ApprovalGate.getRequestSnapshot} instead of trusting the renderer
   * to echo it back. Optional because non-tool kinds (out-of-allowed-dir,
   * agent-action) do not propagate a cache key.
   */
  approvalCacheKey?: string;
  /** Confused-deputy nonce issued for this request (echoed back verbatim) */
  nonce: string;
  /** Expected HMAC for this request (confused-deputy defense) */
  expectedHmac: string;
}

function formatApprovalAuditFields(fields: {
  toolName: string;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  toolCategory?: ToolCategory;
  source?: "builtin" | "plugin" | "mcp";
  sourcePluginId?: string;
  approvalScope?: string;
  trustOrigin?: string;
}): string {
  return [
    `toolName=${fields.toolName}`,
    `category=${fields.category}`,
    `toolCategory=${fields.toolCategory ?? "unknown"}`,
    `kind=${fields.kind ?? "tool"}`,
    `source=${fields.source ?? "unknown"}`,
    `sourcePluginId=${fields.sourcePluginId ?? "none"}`,
    `approvalScope=${fields.approvalScope ?? "none"}`,
    `trustOrigin=${fields.trustOrigin ?? "unknown"}`,
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
    args: maskArgsForDisplay(display, detections),
    reason: RATIONALE_HOST_OWNED_REASON,
    createdAt: request.createdAt,
    requireExplicit: true,
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

  /**
   * Round-4 architect MAJOR — injectable sandbox-capability provider.
   * Defaults to {@link detectSandboxCapability} but can be overridden
   * at construction time (tests, future async probe). Avoids the
   * tight module-level coupling that complicated unit testing in
   * round 3.
   */
  private readonly sandboxCapabilityProvider: () => SandboxCapability;

  constructor(
    webContents: WebContents,
    initialPolicy?: PolicyFile,
    timeoutMs = TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs,
    auditLogger?: AuditLogger,
    notificationService?: NotificationService,
    sandboxCapabilityProvider: () => SandboxCapability = detectSandboxCapability,
  ) {
    this.webContents = webContents;
    this.timeoutMs = timeoutMs;
    this.auditLogger = auditLogger;
    this.notificationService = notificationService;
    this.sandboxCapabilityProvider = sandboxCapabilityProvider;
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
   * Send an approval request to the renderer and wait for the response.
   * ConversationLoop.executeOne() awaits this and blocks the turn.
   * The requireExplicit field controls renderer dismiss behavior.
   */
  async requestAndWait(
    req: Omit<ApprovalRequest, "requireExplicit">,
  ): Promise<ApprovalDecision> {
    const rationaleDisplay = parseValidRationaleApprovalDisplay(req);

    // Rationale is a host-owned, one-shot approval surface. Validate its
    // narrow explanatory card before any enrichment, notification, nonce
    // minting, or renderer IPC so a malformed/mismatched request cannot turn
    // into a clickable approval dialog.
    if (req.kind === "rationale" && rationaleDisplay === null) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:rationale-display-invalid] ${req.id} ${formatApprovalAuditFields(req)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
    }

    // Round-3 code-reviewer MAJOR + round-4 critic CRITICAL + round-5
    // critic MAJOR-1 — sandbox capability injection is scoped to the
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
      ...req,
      // Rationale's generic reason is deliberately not caller-controlled.
      // Set this before all downstream handling, including audit, OS
      // notification, HMAC sealing, pending state, and renderer narrowing.
      reason:
        req.kind === "rationale" && rationaleDisplay !== null
          ? RATIONALE_HOST_OWNED_REASON
          : req.reason,
      sandboxCapability:
        req.sandboxCapability ??
        (isExecutionKind ? this.sandboxCapabilityProvider() : undefined),
      allowedChoices:
        req.kind === "rationale"
          ? ["allow-once", "deny-once"]
          : req.allowedChoices,
      requireExplicit:
        req.kind === "rationale"
          ? true
          : this.currentPolicy.requireExplicitApproval,
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
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:sensitive-path-blocked] ${fullReq.id} ${formatApprovalAuditFields(fullReq)} raw=${rawCandidate} canonical=${caseFolded} pattern=${matchedPattern} → deny-once (hard-block)`,
        });
        return markHostApprovalRejectedDecision({
          requestId: fullReq.id,
          choice: "deny-once",
          rememberPattern: `Sensitive credential path blocked: ${matchedPattern}`,
        });
      }
    }

    // §S4: isReadOnly short-circuit — if the tool self-declares read-only
    // and we are NOT in plan mode, skip the confirmation dialog. Plan
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
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:read-only-auto-approve] ${fullReq.id} toolName=${fullReq.toolName} trustOrigin=${fullReq.trustOrigin ?? "unknown"} mode=${fullReq.mode ?? "default"} → allow-once`,
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
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:send-failed] ${fullReq.id} ${formatApprovalAuditFields(fullReq)} — webContents already destroyed → deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: fullReq.id,
        choice: "deny-once",
      });
    }

    // §S8 phase: requested
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gate",
      type: "approval",
      // Emit provenance fields needed to distinguish a host tool ask from a
      // plugin-origin agent-action request during incident replay.
      input: `[approval:requested] ${fullReq.id} ${formatApprovalAuditFields(fullReq)}`,
    });

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
    const canonicalArgs = canonicalStringify(fullReq.args);
    const signingInput = `${fullReq.id}|${nonce}|${fullReq.toolName}|${canonicalArgs}`;
    const expectedHmac = createHmac("sha256", this.sessionKey)
      .update(signingInput)
      .digest("hex");
    const signedReq: ApprovalRequest = {
      ...fullReq,
      nonce,
      hmac: expectedHmac,
    };

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(fullReq.id);
        // Timeout: handle as deny-once for fail-safe behavior.
        // §S8 phase: timeout
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:timeout] ${fullReq.id} ${formatApprovalAuditFields(fullReq)} → deny-once`,
        });
        const timeoutDecision: ApprovalDecision = {
          requestId: fullReq.id,
          choice: "deny-once",
        };
        hostTimeoutDecisions.add(timeoutDecision);
        resolve(timeoutDecision);
      }, this.timeoutMs);

      this.pending.set(fullReq.id, {
        resolve,
        reject,
        timer,
        trustOrigin: fullReq.trustOrigin ?? "unknown",
        toolName: fullReq.toolName,
        category: fullReq.category,
        kind: fullReq.kind,
        allowedChoices: fullReq.allowedChoices,
        toolCategory: fullReq.toolCategory,
        source: fullReq.source,
        sourcePluginId: fullReq.sourcePluginId,
        approvalScope: fullReq.approvalScope,
        approvalCacheKey: fullReq.approvalCacheKey,
        nonce,
        expectedHmac,
      });

      // Send the request to the renderer (main→renderer one-way).
      // Mask sensitive args for display; the original args stay inside the executor
      // and are still used for tool execution.
      // Attach nonce+hmac to the masked payload for confused-deputy defense.
      const dlpHits = new Set<string>();
      const maskedSignedReq: ApprovalRequest =
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
      if (dlpHits.size > 0) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
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
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:send-failed] ${fullReq.id} ${formatApprovalAuditFields(fullReq)} error=${sendErr instanceof Error ? sendErr.message : String(sendErr)} → deny-once`,
        });
        resolve(
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
   */
  resolve(
    requestId: string,
    decision: ApprovalDecision,
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
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:nonce-mismatch] ${requestId} ${formatApprovalAuditFields(entry)} choice=${decision.choice} nonceProvided=${decision.nonce ? "yes" : "no"} hmacProvided=${decision.hmac ? "yes" : "no"} → deny-once (forced)`,
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
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:choice-not-allowed] ${requestId} ${formatApprovalAuditFields(entry)} choice=${decision.choice} allowed=${entry.allowedChoices.join(",")} → deny-once (forced)`,
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
    // §S8 phase: decided
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gate",
      type: "approval",
      output: `[approval:decided] ${requestId} ${formatApprovalAuditFields(entry)} choice=${resolvedDecision.choice} rememberPattern=${resolvedDecision.rememberPattern ?? "none"}`,
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
      sessionId: "approval-gate",
      type: "approval",
      output: `[approval:cancelled] ${requestId} ${formatApprovalAuditFields(entry)} reason=${reason} → deny-once`,
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
    source: "builtin" | "plugin" | "mcp";
    trustOrigin: string;
    approvalCacheKey: string | undefined;
  } | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind === "rationale") return null;
    return {
      toolName: entry.toolName,
      // PendingEntry.source can be undefined for legacy callers — default
      // to "builtin" so cache identity is conservative (high-trust source).
      // The strict-record handler additionally validates against the SOT
      // emitter; this default never widens an existing approval.
      source: entry.source ?? "builtin",
      trustOrigin: entry.trustOrigin,
      approvalCacheKey: entry.approvalCacheKey,
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
