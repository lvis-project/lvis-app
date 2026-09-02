



import { ipcMain } from "electron";
import { fanOutToAllWindows } from "../window-fanout.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
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
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("tour-ipc");

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
      if (!validateHostRendererSender(e)) {
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
          { err: errorMessage(err) },
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
      if (!validateHostRendererSender(e)) {
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
          { err: errorMessage(err) },
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
      if (!validateHostRendererSender(e)) {
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
          { err: errorMessage(err) },
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
      if (!validateHostRendererSender(e)) {
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
      // Fan out through the curated app-renderer target set. Keeping this on
      // the shared helper preserves destroyed-window and send-race handling
      // if another trusted renderer surface is added later. `fanOutToAllWindows`
      // composes on safe-send's
      // per-window destroyed-check + send-race swallow; `log` receives the
      // per-window warn so one window's failure never blocks the others.
      const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
      fanOutToAllWindows(targets, TOUR_START_CHANNEL, { scenarioId }, { logger: log });
      return { ok: true, scenarioId };
    },
  );

}
