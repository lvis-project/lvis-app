import { describe, expect, it } from "vitest";
import { t } from "../../i18n/runtime.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { shellExecutionEnvironmentLines, shellExecutionEnvironmentPrompt } from "../shell-execution-environment.js";

function plan(sandbox: boolean) {
  return buildHostShellExecutionPlan({
    platform: "darwin",
    requestedSandbox: sandbox,
    activeCapability: {
      kind: sandbox ? "asrt" : "none",
      confidence: "verified",
      platform: "darwin",
      confines: { filesystem: sandbox, process: sandbox, network: sandbox },
    },
  });
}

describe("shell execution environment", () => {
  it("separates the host location from the temporary home and authentication boundary", () => {
    const lines = shellExecutionEnvironmentLines(plan(true));
    expect(lines).toContain(t("shellExecution.location", { platform: "darwin" }));
    expect(lines).toContain(t("shellExecution.temporaryHome"));
    expect(lines).toContain(t("shellExecution.isolatedAuthentication"));
    expect(lines).not.toContain(t("shellExecution.hostHome"));
  });

  it("describes the actual plain child even when a sandbox was requested", () => {
    const fallback = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true,
      activeCapability: { kind: "none", confidence: "verified", platform: "linux" },
    });
    expect(shellExecutionEnvironmentLines(fallback)).toContain(t("shellExecution.hostHome"));
    expect(shellExecutionEnvironmentLines(fallback)).toContain(t("shellExecution.hostAuthentication"));
    expect(shellExecutionEnvironmentLines(fallback)).not.toContain(t("shellExecution.temporaryHome"));
  });

  it("does not promise an interactive approval surface to a headless turn", () => {
    const prompt = shellExecutionEnvironmentPrompt(plan(true), false);
    expect(prompt).toContain(t("shellExecution.noInteractiveApproval"));
    expect(prompt).not.toContain(t("shellExecution.hostRequest"));
    expect(prompt).toContain(t("shellExecution.pipelineStatus"));
  });

  it("does not project arbitrary host environment values", () => {
    const projected = shellExecutionEnvironmentPrompt({
      ...plan(false),
      ...{ environment: { HOME: "/private-user-home", GH_TOKEN: "private-test-value" } },
    }, true);
    expect(projected).not.toContain("/private-user-home");
    expect(projected).not.toContain("private-test-value");
    expect(projected).toContain(t("shellExecution.currentUser"));
  });
});
