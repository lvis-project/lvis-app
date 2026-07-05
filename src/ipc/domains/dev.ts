



import { ipcMain } from "electron";
import {
  setRuntimePreflightOverride,
  getRuntimePreflightOverride,
  getModelPreflightThreshold,
} from "../../engine/auto-compact.js";
import { getIsPackaged } from "../../boot/dev-flags.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";

const log = createLogger("ipc-dev");

export function registerDevHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(CHANNELS.dev.setPreflightOverride, (e, raw: unknown) => {
    if (getIsPackaged()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.dev.setPreflightOverride, e);
      return UNAUTHORIZED_FRAME;
    }
    const n: number | null = raw === null ? null : Number(raw);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) {
      return { ok: false, error: "invalid-value" } as const;
    }
    setRuntimePreflightOverride(n);
    log.info(`dev preflight override set to: ${n === null ? "(cleared)" : `${n} tokens`}`);
    return { ok: true, value: getRuntimePreflightOverride() } as const;
  });

  ipcMain.handle(CHANNELS.dev.getPreflightStatus, (e) => {
    if (getIsPackaged()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.dev.getPreflightStatus, e);
      return UNAUTHORIZED_FRAME;
    }
    const llm = deps.settingsService.get("llm");
    const provider = llm.provider;
    const model = getLlmVendorSettings(llm.vendors, provider).model;
    const effective = getModelPreflightThreshold(provider, model);
    return {
      ok: true,
      runtimeOverride: getRuntimePreflightOverride(),
      envOverride: process.env.LVIS_DEV_PREFLIGHT_OVERRIDE
        ? Number.parseInt(process.env.LVIS_DEV_PREFLIGHT_OVERRIDE, 10)
        : null,
      effective,
      provider,
      model,
    } as const;
  });
}
