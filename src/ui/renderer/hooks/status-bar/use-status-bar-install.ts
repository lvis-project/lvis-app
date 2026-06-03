import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import type { LvisApi } from "../../types.js";
import type { StatusBarSeverity } from "./types.js";
import { safeField } from "./utils.js";

interface Options {
  api: LvisApi;
  pushToast: (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => string;
}

type InstallProgressPayload =
  | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };

type InstallResultPayload = { slug: string; success: boolean; preparing?: boolean; error?: string };

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
          message = t("useStatusBarInstall.downloadingWithProgress", { progress: `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)}`, target });
        } else {
          message = t("useStatusBarInstall.downloadingNoTotal", { target });
        }
      } else if (payload.phase === "verifying") {
        message = t("useStatusBarInstall.verifying", { target });
      } else if (payload.phase === "registering") {
        message = t("useStatusBarInstall.registering", { target });
      } else if (payload.phase === "restarting") {
        message = t("useStatusBarInstall.restarting", { target });
      } else if (payload.phase === "preparing") {
        message = t("useStatusBarInstall.preparingRuntime", { target });
      } else {
        message = t("useStatusBarInstall.installing", { target });
      }
      pushToast({ severity: "info", message, ttlMs: 8000 });
    };
    const handleInstallResult = ({ slug, success, error }: InstallResultPayload, label = "") => {
      const target = targetLabel(safeField(slug, 64), label);
      if (success) pushToast({ severity: "success", message: t("useStatusBarInstall.installSuccess", { target }) });
      else pushToast({ severity: "error", message: t("useStatusBarInstall.installFailure", { target, error: safeField(error) }), ttlMs: 10000 });
    };
    const handleUninstallResult = ({ slug, success, error }: InstallResultPayload, label = "") => {
      const target = targetLabel(safeField(slug, 64), label);
      if (success) pushToast({ severity: "success", message: t("useStatusBarInstall.uninstallSuccess", { target }) });
      else pushToast({ severity: "error", message: t("useStatusBarInstall.uninstallFailure", { target, error: safeField(error) }), ttlMs: 10000 });
    };

    if (typeof api.onPluginInstallProgress === "function") unsubs.push(api.onPluginInstallProgress((payload) => handleProgress(payload)));
    if (typeof api.onAgentInstallProgress === "function") unsubs.push(api.onAgentInstallProgress((payload) => handleProgress(payload, t("useStatusBarInstall.labelAgent"))));
    if (typeof api.onSkillInstallProgress === "function") unsubs.push(api.onSkillInstallProgress((payload) => handleProgress(payload, t("useStatusBarInstall.labelSkill"))));
    if (typeof api.onPluginInstallResult === "function") unsubs.push(api.onPluginInstallResult((payload) => handleInstallResult(payload)));
    if (typeof api.onAgentInstallResult === "function") unsubs.push(api.onAgentInstallResult((payload) => handleInstallResult(payload, t("useStatusBarInstall.labelAgent"))));
    if (typeof api.onSkillInstallResult === "function") unsubs.push(api.onSkillInstallResult((payload) => handleInstallResult(payload, t("useStatusBarInstall.labelSkill"))));
    if (typeof api.onPluginUninstallResult === "function") unsubs.push(api.onPluginUninstallResult((payload) => handleUninstallResult(payload)));
    if (typeof api.onAgentUninstallResult === "function") unsubs.push(api.onAgentUninstallResult((payload) => handleUninstallResult(payload, t("useStatusBarInstall.labelAgent"))));
    if (typeof api.onSkillUninstallResult === "function") unsubs.push(api.onSkillUninstallResult((payload) => handleUninstallResult(payload, t("useStatusBarInstall.labelSkill"))));
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, pushToast]);
}
