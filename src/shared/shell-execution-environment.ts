import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import { t } from "../i18n/runtime.js";

type ShellEnvironmentPlan = Pick<HostShellExecutionPlanAuditProjection,
  "platform" | "mode" | "capability" | "requiresExplicitUserApproval">;

/** Public descriptions of the selected child, never the host's environment values. */
export function shellExecutionEnvironmentLines(plan: ShellEnvironmentPlan): readonly string[] {
  if (plan.mode === "blocked") return [t("shellExecution.blocked")];
  return [
    t("shellExecution.location", { platform: plan.platform }),
    plan.mode === "asrt" ? t("shellExecution.temporaryHome") : t("shellExecution.hostHome"),
    plan.mode === "asrt" ? t("shellExecution.isolatedAuthentication") : t("shellExecution.hostAuthentication"),
    t("shellExecution.currentUser"),
  ];
}

/** Describe the default route; the final per-call plan remains authoritative. */
export function shellExecutionEnvironmentPrompt(plan: ShellEnvironmentPlan, interactive: boolean): string {
  const confines = plan.capability.confines;
  const confinement = confines === undefined
    ? t("shellExecution.confinementUnspecified")
    : t("shellExecution.confinement", {
      filesystem: String(confines.filesystem),
      process: String(confines.process),
      network: String(confines.network),
    });
  return [
    "<shell-execution-environment>",
    ...shellExecutionEnvironmentLines(plan),
    confinement,
    t("shellExecution.defaultRoute"),
    interactive ? t("shellExecution.hostRequest") : t("shellExecution.noInteractiveApproval"),
    t("shellExecution.pipelineStatus"),
    "</shell-execution-environment>",
  ].join("\n");
}
