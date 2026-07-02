/**
 * Tour domain IPC handlers.
 *
 * Channels:
 *   `lvis:tour:get-state`       — read current tour state from
 *                                 `~/.lvis/onboarding/tour-state.json`.
 *   `lvis:tour:mark-complete`   — mark a scenario as completed.
 *   `lvis:tour:dismiss`         — record a dismissal (ESC / 건너뛰기).
 *   `lvis:tour:start`           — fan-out to every open window asking
 *                                 the renderer to launch a scenario.
 *
 * Error contract (project CLAUDE.md): kebab-case English `error` code +
 * English `message`. The renderer is responsible for translating to
 * Korean for the user.
 *
 * Storage namespace: `~/.lvis/onboarding/` per Storage Namespace per
 * Feature (project CLAUDE.md). The tour-state-store enforces 0o700
 * directory + 0o600 file modes.
 */
import { ipcMain } from "electron";
import { join } from "node:path";
import {
  openFeatureNamespace,
  writeFileAtomicAtPath,
} from "../../main/storage/feature-namespace.js";
import { fanOutToAllWindows } from "../broadcast-helpers.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { createLogger } from "../../lib/logger.js";
import {
  DEFAULT_TOUR_STATE,
  readTourState,
  markScenarioComplete,
  dismissScenario,
  type TourState,
} from "../../main/tour-state-store.js";
import type { IpcDeps } from "../types.js";

/**
 * Tutorial-X4 — onboarding context size cap. The renderer-synthesized
 * markdown should be a short, single-page hint (호칭 + installed plugins
 * + last tour). 4 KB is a generous ceiling — anything larger is almost
 * certainly a renderer bug, and we refuse rather than letting the system
 * prompt balloon.
 */
const ONBOARDING_CONTEXT_MAX_BYTES = 4 * 1024;

const log = createLogger("tour-ipc");

/** `~/.lvis/onboarding/` namespace — owns onboarding-context.md. */
const onboardingNs = openFeatureNamespace("onboarding");

export const TOUR_START_CHANNEL = CHANNELS.tour.start;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function registerTourHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    CHANNELS.tour.getState,
    async (
      e,
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.getState, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const state = await readTourState();
        return { ok: true, state };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "read failed; falling back to default",
        );
        return { ok: true, state: DEFAULT_TOUR_STATE };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.markComplete,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.markComplete, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      try {
        const state = await markScenarioComplete(scenarioId);
        return { ok: true, state };
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "mark-complete failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.dismiss,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.dismiss, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      try {
        const state = await dismissScenario(scenarioId);
        return { ok: true, state };
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "dismiss failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.start,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.start, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      // Fan out to every open app window so e.g. a Settings → Help button
      // pressed in the main window can also launch the tour inside a
      // detached pane. `fanOutToAllWindows` composes on safe-send's
      // per-window destroyed-check + send-race swallow; `log` receives the
      // per-window warn so one window's failure never blocks the others.
      const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
      fanOutToAllWindows(targets, TOUR_START_CHANNEL, { scenarioId }, { logger: log });
      return { ok: true, scenarioId };
    },
  );

  // Tutorial-X4 — write the renderer-synthesized onboarding context to
  // `~/.lvis/onboarding/onboarding-context.md`. The system prompt builder
  // (boot/conversation.ts) reads this file each turn and injects it as
  // section id=9.86 "User Onboarding Context" when non-empty. Renderer
  // calls this once after MemorySeedDialog dismissal with a brief markdown
  // block (호칭 + installed plugins + last tour). Empty `content` is
  // treated as "clear" (write empty string) — keeps the file present so a
  // future read short-circuits cleanly.
  ipcMain.handle(
    CHANNELS.onboarding.contextSet,
    async (
      e,
      payload: { content?: unknown },
    ): Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.onboarding.contextSet, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const content = payload?.content;
      if (typeof content !== "string") {
        return {
          ok: false,
          error: "invalid-content",
          message: "content must be a string",
        };
      }
      if (Buffer.byteLength(content, "utf-8") > ONBOARDING_CONTEXT_MAX_BYTES) {
        return {
          ok: false,
          error: "content-too-large",
          message: `content exceeds ${ONBOARDING_CONTEXT_MAX_BYTES} bytes`,
        };
      }
      try {
        // Raw markdown (not JSON) lives in the `~/.lvis/onboarding/`
        // namespace alongside tour-state.json. writeFileAtomicAtPath
        // materializes the 0o700 directory and atomically writes the file
        // 0o600 via the shared SOT helper, so the mode contract is never
        // re-derived inline.
        await writeFileAtomicAtPath(
          join(onboardingNs.dir, "onboarding-context.md"),
          content,
        );
        return { ok: true };
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "onboarding-context write failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );
}
