/**
 * Dev domain IPC — only active in non-production NODE_ENV.
 *
 * Channels:
 *   lvis:dev:setPreflightOverride  → engine 의 runtime preflight override 설정
 *   lvis:dev:getPreflightStatus    → 현재 override 값 + computed 기본값 조회
 *
 * Dev UI (renderer) 의 floating panel 이 호출해서 LLM compact 트리거 임계를
 * 실시간으로 조절. production NODE_ENV 에서는 setter 가 no-op 으로 거부.
 */
import { ipcMain } from "electron";
import {
  setRuntimePreflightOverride,
  getRuntimePreflightOverride,
  getModelPreflightThreshold,
} from "../../engine/auto-compact.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("ipc-dev");

function isDevMode(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function registerDevHandlers(deps: IpcDeps): void {
  ipcMain.handle("lvis:dev:setPreflightOverride", (_evt, raw: unknown) => {
    if (!isDevMode()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    const n: number | null = raw === null ? null : Number(raw);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) {
      return { ok: false, error: "invalid-value" } as const;
    }
    setRuntimePreflightOverride(n);
    log.info(`dev preflight override set to: ${n === null ? "(cleared)" : `${n} tokens`}`);
    return { ok: true, value: getRuntimePreflightOverride() } as const;
  });

  ipcMain.handle("lvis:dev:getPreflightStatus", () => {
    if (!isDevMode()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    const llm = deps.settingsService.get("llm");
    const provider = llm.provider;
    const model = llm.vendors[provider].model;
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
