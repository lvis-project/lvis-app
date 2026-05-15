import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { StatusBarSeverity } from "./types.js";
import { safeField } from "./utils.js";

interface Options {
  api: LvisApi;
  pushToast: (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => string;
}

type InstallProgressPayload =
  | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };

type InstallResultPayload = { slug: string; success: boolean; error?: string };

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function targetLabel(slug: string, label: string): string {
  return label ? `${slug} ${label}` : slug;
}

export function useStatusBarInstall({ api, pushToast }: Options): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const handleProgress = (payload: InstallProgressPayload, label = "") => {
      const safeSlug = safeField(payload.slug, 64);
      const target = targetLabel(safeSlug, label);
      let message: string;
      if (payload.phase === "downloading") {
        const { bytesDownloaded, bytesTotal } = payload;
        if (bytesTotal !== null) {
          message = `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)} · ${target} 다운로드 중`;
        } else {
          message = `${target} … 다운로드 중`;
        }
      } else if (payload.phase === "verifying") {
        message = `${target} 검증 중…`;
      } else if (payload.phase === "registering") {
        message = `${target} 등록 중…`;
      } else if (payload.phase === "restarting") {
        message = `${target} 재시작 중…`;
      } else {
        message = `${target} 설치 중…`;
      }
      pushToast({ severity: "info", message, ttlMs: 8000 });
    };
    const handleInstallResult = ({ slug, success, error }: InstallResultPayload, label = "") => {
      const target = targetLabel(safeField(slug, 64), label);
      if (success) pushToast({ severity: "success", message: `${target} 설치 완료` });
      else pushToast({ severity: "error", message: `${target} 설치 실패: ${safeField(error)}`, ttlMs: 10000 });
    };
    const handleUninstallResult = ({ slug, success, error }: InstallResultPayload, label = "") => {
      const target = targetLabel(safeField(slug, 64), label);
      if (success) pushToast({ severity: "success", message: `${target} 제거 완료` });
      else pushToast({ severity: "error", message: `${target} 제거 실패: ${safeField(error)}`, ttlMs: 10000 });
    };

    if (typeof api.onPluginInstallProgress === "function") unsubs.push(api.onPluginInstallProgress((payload) => handleProgress(payload)));
    if (typeof api.onAgentInstallProgress === "function") unsubs.push(api.onAgentInstallProgress((payload) => handleProgress(payload, "에이전트")));
    if (typeof api.onSkillInstallProgress === "function") unsubs.push(api.onSkillInstallProgress((payload) => handleProgress(payload, "스킬")));
    if (typeof api.onPluginInstallResult === "function") unsubs.push(api.onPluginInstallResult((payload) => handleInstallResult(payload)));
    if (typeof api.onAgentInstallResult === "function") unsubs.push(api.onAgentInstallResult((payload) => handleInstallResult(payload, "에이전트")));
    if (typeof api.onSkillInstallResult === "function") unsubs.push(api.onSkillInstallResult((payload) => handleInstallResult(payload, "스킬")));
    if (typeof api.onPluginUninstallResult === "function") unsubs.push(api.onPluginUninstallResult((payload) => handleUninstallResult(payload)));
    if (typeof api.onAgentUninstallResult === "function") unsubs.push(api.onAgentUninstallResult((payload) => handleUninstallResult(payload, "에이전트")));
    if (typeof api.onSkillUninstallResult === "function") unsubs.push(api.onSkillUninstallResult((payload) => handleUninstallResult(payload, "스킬")));
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, pushToast]);
}
