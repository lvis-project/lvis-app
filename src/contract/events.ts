/**
 * events.ts — the streaming / emitter contract (#1409 contract SOT).
 *
 * A discriminated union (`AppEvent`, keyed by `channel`) over the event channels
 * the renderer RECEIVES via `webContents.send` (main → renderer, plus the plugin
 * webview fan-out). This is the SSE/emitter contract the C10 bridge maps onto.
 *
 * Grounding: every channel name below is a real `webContents.send` /
 * `sendToWebContents` / `sendToWindow` target found in the IPC domains
 * (`chat.ts`, `plugins.ts`, `permissions.ts`, `work-board`/`routines` wiring).
 * Payload shapes are typed where they are fully grounded in the emitter call
 * site; the more complex ones are left `unknown` and typed incrementally by C10
 * rather than invented ahead of the bridge.
 */

import {
  PERMISSIONS,
  WORK_BOARD,
  ROUTINES_V2,
  OVERLAY_V1,
} from "./app-contract.js";

/** Event channel names the renderer subscribes to (main → renderer). */
export const EVENT_CHANNELS = {
  // Chat streaming (per-turn) + provider fallback notice.
  chatStream: "lvis:chat:stream",
  chatFallback: "lvis:chat:fallback",
  // Permissions surface.
  permissionsModeChanged: PERMISSIONS.modeChanged,
  permissionsConfigChanged: PERMISSIONS.configChanged,
  permissionsDeferredPending: PERMISSIONS.deferredPending,
  permissionsUserApprovalHit: PERMISSIONS.userApprovalHit,
  permissionsReviewSuggestion: PERMISSIONS.reviewSuggestion,
  permissionsManifestViolation: PERMISSIONS.manifestViolation,
  // Work-board run lifecycle.
  workBoardItemChanged: WORK_BOARD.itemChanged,
  workBoardRunProgress: WORK_BOARD.runProgress,
  workBoardRunStarted: WORK_BOARD.runStarted,
  workBoardRunFinished: WORK_BOARD.runFinished,
  workBoardRunFailed: WORK_BOARD.runFailed,
  // Routine v2 lifecycle.
  routinesFired: ROUTINES_V2.fired,
  routinesRunningStarted: ROUTINES_V2.runningStarted,
  routinesRunningFinished: ROUTINES_V2.runningFinished,
  routinesFailed: ROUTINES_V2.failed,
  // Plugin webview fan-out (main → plugin frame).
  pluginEvent: "lvis:plugin:event",
  // Overlay queue (main → renderer).
  overlayShow: OVERLAY_V1.show,
  overlayUpdate: OVERLAY_V1.update,
  overlayDismiss: OVERLAY_V1.dismiss,
} as const;

/** Any event channel name in {@link EVENT_CHANNELS}. */
export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

/**
 * Per-turn chat stream event `type` tags (grounded in `chat.ts` runStreamedTurn
 * / manualCompact). The per-`type` payload field shapes are typed incrementally
 * in C10 when the SSE bridge lands; kept open here to avoid inventing shapes
 * ahead of the bridge.
 */
export type ChatStreamEventType =
  | "reasoning_delta"
  | "text_delta"
  | "assistant_round"
  | "tool_start"
  | "permission_review"
  | "tool_end"
  | "error"
  | "permission_mode_changed"
  | "compact_started"
  | "recovery_exhausted"
  | "compact_notice"
  | "turn_summary"
  | "llm_status"
  | "guidance_injected"
  | "guidance_dropped"
  | "redact_notice"
  | "suggested_replies"
  | "done";

/** One frame on the `lvis:chat:stream` channel. */
export interface ChatStreamEvent {
  /** Per-turn stream correlation id (absent on out-of-turn compact events). */
  streamId?: number;
  type: ChatStreamEventType;
  // Payload fields vary by `type`; typed incrementally in C10.
  [key: string]: unknown;
}

/** Provider fallback notice on `lvis:chat:fallback`. */
export interface ChatFallbackEvent {
  from: string;
  to: string;
}

/**
 * Discriminated union (keyed by `channel`) of every event the renderer receives.
 * The C10 SSE/emitter bridge translates host emits into these frames.
 */
export type AppEvent =
  | { channel: typeof EVENT_CHANNELS.chatStream; payload: ChatStreamEvent }
  | { channel: typeof EVENT_CHANNELS.chatFallback; payload: ChatFallbackEvent }
  | { channel: typeof EVENT_CHANNELS.permissionsModeChanged; payload: { mode: string } }
  | { channel: typeof EVENT_CHANNELS.permissionsConfigChanged; payload: Record<string, never> }
  | { channel: typeof EVENT_CHANNELS.permissionsDeferredPending; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.permissionsUserApprovalHit; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.permissionsReviewSuggestion; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.permissionsManifestViolation; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.workBoardItemChanged; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.workBoardRunProgress; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.workBoardRunStarted; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.workBoardRunFinished; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.workBoardRunFailed; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.routinesFired; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.routinesRunningStarted; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.routinesRunningFinished; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.routinesFailed; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.pluginEvent; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.overlayShow; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.overlayUpdate; payload: unknown }
  | { channel: typeof EVENT_CHANNELS.overlayDismiss; payload: { id: string } };
