import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const DISABLED = { ok: false, error: "a2a-remote-disabled" as const };
const OPERATION_REJECTED = { ok: false, error: "a2a-remote-operation-rejected" as const };

export function registerRemoteA2AHandlers(deps: IpcDeps): void {
  ipcMain.handle(CHANNELS.remoteA2a.targets, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.remoteA2a.targets, event);
      return UNAUTHORIZED_FRAME;
    }
    const controller = deps.remoteA2AActionController;
    if (!controller) return DISABLED;
    try {
      return { ok: true, targets: controller.listTargets() };
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.remoteA2a.status, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.remoteA2a.status, event);
      return UNAUTHORIZED_FRAME;
    }
    const controller = deps.remoteA2AActionController;
    if (!controller) return DISABLED;
    try {
      return { ok: true, status: controller.status() };
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.remoteA2a.send, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.remoteA2a.send, event);
      return UNAUTHORIZED_FRAME;
    }
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (!hasUserKeyboardIntent(value.intentToken)) {
      return { ok: false, error: "user-keyboard-required" as const };
    }
    const controller = deps.remoteA2AActionController;
    if (!controller) return DISABLED;
    if (!Number.isSafeInteger(value.targetAgentId) || typeof value.userIntent !== "string") {
      return { ok: false, error: "a2a-remote-input-invalid" as const };
    }
    try {
      const status = await controller.send({
        targetAgentId: value.targetAgentId as number,
        intent: value.userIntent,
      });
      return { ok: true, status };
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.remoteA2a.task, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.remoteA2a.task, event);
      return UNAUTHORIZED_FRAME;
    }
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (Object.keys(value).sort().join(",") !== "taskHandle" || typeof value.taskHandle !== "string") {
      return { ok: false, error: "a2a-remote-input-invalid" as const };
    }
    const controller = deps.remoteA2AActionController;
    if (!controller) return DISABLED;
    try {
      const status = await controller.get({ taskHandle: value.taskHandle });
      return { ok: true, status };
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.remoteA2a.action, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.remoteA2a.action, event);
      return UNAUTHORIZED_FRAME;
    }
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (!hasUserKeyboardIntent(value.intentToken)) return { ok: false, error: "user-keyboard-required" as const };
    const controller = deps.remoteA2AActionController;
    if (!controller) return DISABLED;
    if ((value.action !== "resume" && value.action !== "cancel" && value.action !== "replay")
      || typeof value.taskHandle !== "string"
      || (value.action === "resume" ? typeof value.userIntent !== "string" : value.userIntent !== undefined)) {
      return { ok: false, error: "a2a-remote-input-invalid" as const };
    }
    try {
      const status = value.action === "resume"
        ? await controller.resume({ taskHandle: value.taskHandle, intent: value.userIntent as string })
        : value.action === "cancel"
          ? await controller.cancel({ taskHandle: value.taskHandle })
          : await controller.replay({ taskHandle: value.taskHandle });
      return { ok: true, status };
    } catch {
      return OPERATION_REJECTED;
    }
  });
}
