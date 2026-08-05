/**
 * Host-renderer-only IPC for arming and disarming the desk-armed away answerer.
 *
 * Arming is the one gesture in this feature that changes who may answer an
 * approval, so it is the most tightly bound: the host-renderer sender guard,
 * then a live local keyboard intent, then the shape guard, and only then the
 * gate. The renderer never names a conversation — main resolves the open one at
 * execution, the same rule the Tailnet and Telegram owner surfaces follow — so
 * a caller cannot arm an authority over a conversation the owner is not
 * looking at.
 *
 * Nothing here decides what a legal grant is. `parseAwayAuthorityGrant` owns
 * every bound (armable categories, lifetime ceiling, budget ceiling, directory
 * sanitization, and the refusal of a write scope with no directories), and a
 * grant it rejects arrives back here as a plain `false`.
 *
 * Handlers register unconditionally so the channel inventory is stable; a build
 * without an approval gate answers `away-authority-disabled` from inside the
 * handler rather than leaving the channel missing.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import {
  isAwayAuthorityArmInput,
  isAwayAuthorityIntentOnlyInput,
  parseAwayAuthorityStatus,
  type AwayAuthorityDurationPreset,
  type AwayAuthorityMode,
} from "../../shared/away-authority-arm.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({
  ok: false as const,
  error: "away-authority-disabled" as const,
});
const INPUT_INVALID = Object.freeze({
  ok: false as const,
  error: "away-authority-input-invalid" as const,
});
const KEYBOARD_REQUIRED = Object.freeze({ ok: false as const, error: "user-keyboard-required" as const });
const OPERATION_REJECTED = Object.freeze({
  ok: false as const,
  error: "away-authority-operation-rejected" as const,
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "away-authority-unavailable" as const,
});
const NOTHING_ARMED = Object.freeze({ ok: true as const, status: null });
const ARMED_OK = Object.freeze({ ok: true as const });

/**
 * Preset → milliseconds. The longest entry is the ceiling the grant parser
 * enforces, so this table can only ever ask for something that parser accepts;
 * a longer preset would fail to arm rather than widen anything.
 */
const DURATION_MS: Record<AwayAuthorityDurationPreset, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

/**
 * Mode → tool categories, and the only place in the arm path that names those
 * literals. `read-write` includes `read` because a turn that writes a file
 * reads one first, and a grant that answered the write but not the read would
 * stall on the read at a desk nobody is at.
 *
 * `parseAwayAuthorityGrant` still decides whether these categories are armable
 * at all; this table proposes, it does not permit.
 */
const MODE_CATEGORIES: Record<AwayAuthorityMode, readonly string[]> = {
  "read-only": ["read"],
  "read-write": ["read", "write"],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIntent(payload: unknown): boolean {
  return record(payload) && hasUserKeyboardIntent(payload.intent);
}

export function registerAwayAuthorityHandlers(deps: IpcDeps): void {
  ipcMain.handle(CHANNELS.awayAuthority.status, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.status, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    try {
      const snapshot = gate.awayAuthoritySnapshot();
      if (snapshot === null) return NOTHING_ARMED;
      // `awayAuthoritySnapshot` deliberately does no time check — the answerer
      // retires an expired grant when it next sees a call, and until then the
      // object is still there. The desk must not be told "armed" about a grant
      // that can no longer answer anything, so expiry is resolved here, at the
      // moment the question is asked. Retiring it instead would write a
      // `desk-disarm` audit row for something the desk did not do.
      if (Date.now() >= snapshot.expiresAt) return NOTHING_ARMED;
      const status = parseAwayAuthorityStatus({
        // Projected in main so the category literals stay out of the renderer.
        writable: snapshot.categories.includes("write"),
        directories: [...snapshot.directories],
        expiresAt: snapshot.expiresAt,
        remaining: snapshot.remaining,
      });
      return status === null ? UNAVAILABLE : { ok: true as const, status };
    } catch {
      return UNAVAILABLE;
    }
  });

  ipcMain.handle(CHANNELS.awayAuthority.arm, (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.arm, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isAwayAuthorityArmInput(payload)) return INPUT_INVALID;
    try {
      // Resolved here, never received: the renderer cannot name a conversation,
      // so it cannot arm an authority over one the owner is not looking at.
      const conversationId = deps.conversationLoop.getSessionId();
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        return OPERATION_REJECTED;
      }
      return gate.armAwayAuthority({
        conversationId,
        categories: MODE_CATEGORIES[payload.mode],
        directories: payload.directories,
        ttlMs: DURATION_MS[payload.duration],
        budget: payload.budget,
      })
        ? ARMED_OK
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.awayAuthority.disarm, (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.disarm, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isAwayAuthorityIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      // `false` means there was nothing armed, which is the state the caller
      // asked for. Reporting that as a rejection would tell an owner who
      // double-clicked disarm that disarming failed.
      gate.retireAwayAuthority("desk-disarm");
      return ARMED_OK;
    } catch {
      return OPERATION_REJECTED;
    }
  });
}
