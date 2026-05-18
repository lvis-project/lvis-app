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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import { lvisHome } from "../../shared/lvis-home.js";
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

export const TOUR_START_CHANNEL = "lvis:tour:start";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function registerTourHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    "lvis:tour:get-state",
    async (
      e,
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tour:get-state", e);
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
    "lvis:tour:mark-complete",
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tour:mark-complete", e);
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
    "lvis:tour:dismiss",
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tour:dismiss", e);
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
    "lvis:tour:start",
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tour:start", e);
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
      // detached pane. One window's send failure must not block the others.
      const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
      for (const win of targets) {
        if (!win || win.isDestroyed?.()) continue;
        try {
          win.webContents.send(TOUR_START_CHANNEL, { scenarioId });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "tour-start broadcast failed for one window",
          );
        }
      }
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
    "lvis:onboarding:context:set",
    async (
      e,
      payload: { content?: unknown },
    ): Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:onboarding:context:set", e);
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
        const path = join(lvisHome(), "onboarding", "onboarding-context.md");
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
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
