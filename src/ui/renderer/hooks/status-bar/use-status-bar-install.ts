import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { StatusBarSeverity } from "./types.js";

interface Options {
  api: LvisApi;
  pushToast: (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => string;
}

const TOAST_FIELD_MAX = 120;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
function safeField(input: unknown, max: number = TOAST_FIELD_MAX): string {
  return String(input ?? "unknown").replace(CONTROL_CHARS, "").slice(0, max);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function useStatusBarInstall({ api, pushToast }: Options): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          const safeSlug = safeField(payload.slug, 64);
          let message: string;
          if (payload.phase === "downloading") {
            const { bytesDownloaded, bytesTotal } = payload;
            if (bytesTotal !== null) {
              message = `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)} · ${safeSlug} 다운로드 중`;
            } else {
              message = `${safeSlug} … 다운로드 중`;
            }
          } else if (payload.phase === "verifying") {
            message = `${safeSlug} 검증 중…`;
          } else if (payload.phase === "registering") {
            message = `${safeSlug} 등록 중…`;
          } else if (payload.phase === "restarting") {
            message = `${safeSlug} 재시작 중…`;
          } else {
            message = `${safeSlug} 설치 중…`;
          }
          pushToast({ severity: "info", message, ttlMs: 8000 });
        }),
      );
    }
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult(({ slug, success, error }) => {
          const safeSlug = safeField(slug, 64);
          if (success) pushToast({ severity: "success", message: `${safeSlug} 설치 완료` });
          else pushToast({ severity: "error", message: `${safeSlug} 설치 실패: ${safeField(error)}`, ttlMs: 10000 });
        }),
      );
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(
        api.onPluginUninstallResult(({ slug, success, error }) => {
          const safeSlug = safeField(slug, 64);
          if (success) pushToast({ severity: "success", message: `${safeSlug} 제거 완료` });
          else pushToast({ severity: "error", message: `${safeSlug} 제거 실패: ${safeField(error)}`, ttlMs: 10000 });
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, pushToast]);
}
