import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import { t } from "../i18n/index.js";
import { isExternalOrigin, type ExternalOrigin, type TrustOrigin } from "../contract/trust-origin.js";
import type { ApprovalGate } from "./approval-gate.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionModeCommand } from "./permission-slash.js";
import type { ExecutionMode } from "../shared/permission-mode.js";

export type PermissionModeApplyResult =
  | {
      ok: true;
      previous: string;
      mode: PermissionModeCommand["mode"];
      durable: boolean;
    }
  | {
      ok: false;
      error: string;
      message: string;
    };

/**
 * The explicit-user-action confirmation an out-of-band caller has ALREADY
 * obtained for a durable permission set-mode mutation, so
 * {@link applyPermissionModeCommand} does NOT show a second in-app approval
 * prompt. Two discriminated variants for the two confirmation surfaces:
 *
 *   - `built-in` (`"settings-ui"` / `"builtin-slash"`) — a first-party renderer
 *     user action. `trustOrigin` is `"user-keyboard"` (the physical key/click).
 *
 *   - `local-api-approval` (#1409) — an EXTERNAL origin (local-api / cli)
 *     initiated the change and the user consented via the in-app ApprovalGate
 *     dock at the transport-lifecycle layer (see
 *     `src/main/local-api-server.ts`) BEFORE the handler ran. The ApprovalGate
 *     "Allow" click IS the explicit user action; the {@link ExternalOrigin}
 *     records WHO initiated it. Widening the guard for this variant is what
 *     prevents a DOUBLE prompt — the consent already happened. It is ALSO the
 *     channel discriminant: see {@link isExternalApprovalBypass} and the
 *     external-channel ceiling in {@link applyPermissionModeCommand}, which
 *     hold that one click to one session and keep `allow` out of reach.
 *
 * Fail-closed: any other source/trustOrigin combination does NOT satisfy the
 * built-in-confirmation guard and falls through to the normal ApprovalGate ask.
 */
export type PermissionModeApprovalBypass =
  | {
      source: "settings-ui" | "builtin-slash";
      trustOrigin: "user-keyboard";
      explicitUserAction: true;
    }
  | {
      source: "local-api-approval";
      /** The external origin that initiated the (already user-approved) change. */
      trustOrigin: ExternalOrigin;
      explicitUserAction: true;
    };

/**
 * The transport-agnostic (plain string / boolean) shape a caller may hand in.
 * Never trusted as-is: {@link resolvePermissionModeApprovalBypass} is the only
 * thing that turns it into a {@link PermissionModeApprovalBypass}.
 */
export interface LoosePermissionModeApprovalBypass {
  source: string;
  trustOrigin: string;
  explicitUserAction: boolean;
}

/**
 * THE narrowing authority for "may this permission-mode change skip the
 * ApprovalGate prompt". Every caller — the IPC set-mode handler, the
 * builtin-slash command path, and `applyPermissionModeCommand` itself — decides
 * through this one function, so the fail-closed trust conditions exist exactly
 * once.
 *
 * The discriminated union pins these conditions at compile time, but the type
 * is not a runtime guarantee: callers hand-build literals and a bad cast at a
 * JS call site can smuggle a non-external `trustOrigin` in. This re-checks at
 * runtime for the same reason `src/api/local-api.ts` does.
 *
 * Anything that does not match a recognized surface returns `undefined` → the
 * normal ApprovalGate ask runs (fail-closed).
 */
export function resolvePermissionModeApprovalBypass(
  bypass: LoosePermissionModeApprovalBypass | PermissionModeApprovalBypass | undefined,
): PermissionModeApprovalBypass | undefined {
  if (!bypass || bypass.explicitUserAction !== true) return undefined;
  if (
    (bypass.source === "settings-ui" || bypass.source === "builtin-slash") &&
    bypass.trustOrigin === "user-keyboard"
  ) {
    return { source: bypass.source, trustOrigin: "user-keyboard", explicitUserAction: true };
  }
  if (bypass.source === "local-api-approval") {
    const origin = bypass.trustOrigin as TrustOrigin;
    if (isExternalOrigin(origin)) {
      return { source: "local-api-approval", trustOrigin: origin, explicitUserAction: true };
    }
  }
  return undefined;
}

/**
 * Is this resolved confirmation the EXTERNAL channel (local API / CLI / SDK)
 * rather than a first-party renderer surface?
 *
 * The `source` discriminant on {@link PermissionModeApprovalBypass} is ALREADY
 * the channel axis — `settings-ui` / `builtin-slash` are in-app surfaces the
 * user drove directly, `local-api-approval` is an out-of-process caller whose
 * change a human merely consented to once through the ApprovalGate dock. This
 * predicate names that split so the ceiling below reads as policy rather than
 * as a string comparison, and so no second "isExternal" flag has to be threaded
 * through the transports.
 */
export function isExternalApprovalBypass(
  bypass: PermissionModeApprovalBypass | undefined,
): bypass is Extract<PermissionModeApprovalBypass, { source: "local-api-approval" }> {
  return bypass?.source === "local-api-approval";
}

/**
 * Modes the EXTERNAL channel may never select.
 *
 * `allow` is the mode that removes tool prompting entirely, so setting it
 * converts a single ApprovalGate click into blanket, open-ended authority over
 * every later tool call. That is not what the human answered: the dock asks
 * "change the permission mode", not "stop asking me about anything, forever".
 * The in-app surfaces keep `allow` — a user standing in the permission settings
 * choosing it IS the consent — but an out-of-process caller cannot reach it.
 */
const EXTERNAL_CHANNEL_FORBIDDEN_MODES: readonly ExecutionMode[] = ["allow"];

export async function applyPermissionModeCommand(
  cmd: PermissionModeCommand,
  deps: {
    permissionManager: PermissionManager;
    approvalGate?: ApprovalGate;
    auditLogger?: Pick<AuditLogger, "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
    approvalBypass?: PermissionModeApprovalBypass;
  },
): Promise<PermissionModeApplyResult> {
  const previous = deps.permissionManager.getMode();

  // A durable mode change skips the in-app ApprovalGate ask ONLY when the
  // caller supplies an explicit-user-action confirmation obtained on a trusted
  // surface. Two accepted surfaces (see PermissionModeApprovalBypass):
  //   - first-party renderer built-in (settings-ui / builtin-slash) with a
  //     "user-keyboard" gesture, OR
  //   - "local-api-approval" (#1409): an external origin whose durable change
  //     the user ALREADY consented to via the ApprovalGate dock at the
  //     transport-lifecycle layer. Honoring it here is deliberate — it prevents
  //     a SECOND prompt for a mutation the human just approved. It is NOT a
  //     silent bypass: no "local-api-approval" bypass is ever constructed unless
  //     `local-api-server.ts` observed a real ApprovalGate "allow" decision.
  const trustedConfirmation = resolvePermissionModeApprovalBypass(deps.approvalBypass);

  // EXTERNAL-CHANNEL CEILING. The ApprovalGate consent an out-of-process caller
  // obtained is ONE click on ONE request; it is not a mandate to hand that
  // caller powers the click did not describe. Two limits, enforced here (the
  // authority) rather than only at the transport that happens to call in today:
  //
  //   - not durable — the effect lasts the session the human was looking at,
  //     not every session from now on;
  //   - not `allow` — see EXTERNAL_CHANNEL_FORBIDDEN_MODES.
  //
  // Both are unreachable from the renderer surfaces (`settings-ui` /
  // `builtin-slash`), which are a different trust context and keep what they
  // had. The durable refusal is defence in depth: `handleSetPermissionMode`
  // already declines to mark an external command durable, so reaching it means
  // a caller hand-built a durable command for the external channel.
  if (isExternalApprovalBypass(trustedConfirmation)) {
    if (EXTERNAL_CHANNEL_FORBIDDEN_MODES.includes(cmd.mode)) {
      return {
        ok: false,
        error: "external-mode-forbidden",
        message: t("be_permissionModeApply.externalModeForbidden", { mode: cmd.mode }),
      };
    }
    if (cmd.durable) {
      return {
        ok: false,
        error: "external-durable-forbidden",
        message: t("be_permissionModeApply.externalDurableForbidden"),
      };
    }
  }

  if (cmd.durable && !trustedConfirmation) {
    if (!deps.approvalGate) {
      return {
        ok: false,
        error: "approval-gate-unavailable",
        message: t("be_permissionModeApply.approvalGateUnavailable"),
      };
    }
    const decision = await deps.approvalGate.requestAndWait({
      id: randomUUID(),
      category: "tool",
      toolName: "/permission mode",
      toolCategory: "meta",
      args: { fromMode: previous, toMode: cmd.mode, durable: true },
      reason: t("be_permissionModeApply.approvalReason", { mode: cmd.mode }),
      source: "builtin",
      createdAt: Date.now(),
      trustOrigin: "user-keyboard",
      isReadOnly: false,
      mode: "default",
    });
    if (decision.choice !== "allow-once" && decision.choice !== "allow-always") {
      return {
        ok: false,
        error: "durable-mode-denied",
        message: t("be_permissionModeApply.durableModeDenied"),
      };
    }
  }

  if (deps.auditLogger) {
    if (!deps.auditLogger.isPermissionAuditChainReady()) {
      return {
        ok: false,
        error: "permission-audit-not-ready",
        message: t("be_permissionModeApply.auditChainNotReady"),
      };
    }
    try {
      await deps.auditLogger.appendPermissionAuditEntry({
        decision: "mode_change",
        auditId: randomUUID(),
        ts: new Date().toISOString(),
        trustOrigin: "user-keyboard",
        fromMode: previous,
        toMode: cmd.mode,
        durable: cmd.durable,
        confirmationSource: trustedConfirmation?.source,
      });
    } catch (err) {
      return {
        ok: false,
        error: "permission-audit-write-failed",
        message: t("be_permissionModeApply.auditWriteFailed", { message: (err as Error).message }),
      };
    }
  }

  if (cmd.durable) {
    await deps.permissionManager.setModePersist(cmd.mode);
  } else {
    deps.permissionManager.setMode(cmd.mode);
  }

  return {
    ok: true,
    previous,
    mode: cmd.mode,
    durable: cmd.durable,
  };
}
