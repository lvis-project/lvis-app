/**
 * Dev domain IPC — only registered when !app.isPackaged.
 *
 * Channels:
 *   lvis:dev:setPreflightOverride  → engine 의 runtime preflight override 설정
 *   lvis:dev:getPreflightStatus    → 현재 override 값 + computed 기본값 조회
 *
 * Dev UI (renderer) 의 floating panel 이 호출해서 LLM compact 트리거 임계를
 * 실시간으로 조절. `registerDevHandlers` 는 boot 에서 `getIsPackaged()` 가
 * false 일 때만 호출됨 (`src/ipc/index.ts`). Defense-in-depth 로 핸들러
 * 안에서 한 번 더 확인 + main-frame sender validation.
 */
import { ipcMain } from "electron";
import {
  setRuntimePreflightOverride,
  getRuntimePreflightOverride,
  getModelPreflightThreshold,
} from "../../engine/auto-compact.js";
import { getIsPackaged } from "../../boot/dev-flags.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("ipc-dev");

export function registerDevHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle("lvis:dev:setPreflightOverride", (e, raw: unknown) => {
    if (getIsPackaged()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:dev:setPreflightOverride", e);
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

  ipcMain.handle("lvis:dev:getPreflightStatus", (e) => {
    if (getIsPackaged()) {
      return { ok: false, error: "production-disabled" } as const;
    }
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:dev:getPreflightStatus", e);
      return UNAUTHORIZED_FRAME;
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
