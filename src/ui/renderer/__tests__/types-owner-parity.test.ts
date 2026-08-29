/**
 * The renderer's `types.ts` used to hand-mirror main-process types. These
 * assertions pin every re-export to the owner type so the two sides cannot
 * drift again: a divergence fails `check:typecheck-tests`, not a UI at runtime.
 */
import { describe, expectTypeOf, it } from "vitest";
import type {
  AppSettings,
  ApprovalChoice,
  ApprovalDecision,
  ApprovalRequest,
  DeferredQueueEntry,
  ExecutionMode,
  HookTrustRow,
  MemoryCaptureMode,
  ParentAdjudicationBackgroundEscalation,
  ParentAdjudicationMaxVerdict,
  ParentAdjudicationModelSource,
  PermissionRule,
  PluginContributionTrustRow,
  PluginPerfStats,
  RemoteA2AActionStatus,
} from "../types.js";
import type {
  AppSettings as HostAppSettings,
  MemoryCaptureMode as HostMemoryCaptureMode,
} from "../../../data/settings-store.js";
import type { RendererSettingsSnapshot } from "../../../ipc/domains/settings.js";
import type {
  ApprovalChoice as GateApprovalChoice,
  ApprovalDecision as GateApprovalDecision,
  ApprovalRequest as GateApprovalRequest,
} from "../../../permissions/approval-gate.js";
import type { PermissionRule as HostPermissionRule } from "../../../permissions/permission-manager.js";
import type {
  ParentAdjudicationBackgroundEscalation as HostParentAdjudicationBackgroundEscalation,
  ParentAdjudicationMaxVerdict as HostParentAdjudicationMaxVerdict,
  ParentAdjudicationModelSource as HostParentAdjudicationModelSource,
} from "../../../permissions/permission-settings-store.js";
import type { HookTrustRow as HostHookTrustRow } from "../../../hooks/hook-trust-commands.js";
import type { ScriptHookType } from "../../../hooks/script-hook-types.js";
import type { PluginPerfStats as HostPluginPerfStats } from "../../../plugins/runtime/index.js";
import type { PluginContributionTrustRow as HostPluginContributionTrustRow } from "../../../plugins/plugin-bundle-lifecycle.js";
import type { RemoteA2AActionStatus as HostRemoteA2AActionStatus } from "../../../main/remote-a2a-action-controller.js";
import type { DeferredEntry } from "../../../permissions/reviewer/deferred-queue.js";
import type {
  DeferredGrantScope,
  RiskLevel,
  ToolCategory,
  ToolSource,
} from "../../../shared/permission-review-status.js";
import type {
  ToolCategory as ToolsToolCategory,
  ToolSource as ToolsToolSource,
} from "../../../tools/types.js";
import type { RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import type { ExecutionMode as HostExecutionMode } from "../../../shared/permission-mode.js";
import type { PermissionModeCommand } from "../../../permissions/permission-slash.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import type { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";

describe("renderer types are the owner types", () => {
  it("AppSettings is the host settings minus the main-only a2aRemote block", () => {
    expectTypeOf<AppSettings>().toEqualTypeOf<RendererSettingsSnapshot>();
    expectTypeOf<AppSettings>().toEqualTypeOf<Omit<HostAppSettings, "a2aRemote">>();
    expectTypeOf<"a2aRemote">().not.toMatchTypeOf<keyof AppSettings>();
    expectTypeOf<MemoryCaptureMode>().toEqualTypeOf<HostMemoryCaptureMode>();
  });

  it("approval and permission contracts are the gate's own types", () => {
    expectTypeOf<ApprovalRequest>().toEqualTypeOf<GateApprovalRequest>();
    expectTypeOf<ApprovalDecision>().toEqualTypeOf<GateApprovalDecision>();
    expectTypeOf<ApprovalChoice>().toEqualTypeOf<GateApprovalChoice>();
    expectTypeOf<PermissionRule>().toEqualTypeOf<HostPermissionRule>();
    expectTypeOf<ParentAdjudicationMaxVerdict>().toEqualTypeOf<HostParentAdjudicationMaxVerdict>();
    expectTypeOf<ParentAdjudicationBackgroundEscalation>().toEqualTypeOf<HostParentAdjudicationBackgroundEscalation>();
    expectTypeOf<ParentAdjudicationModelSource>().toEqualTypeOf<HostParentAdjudicationModelSource>();
  });

  it("plugin, hook and remote-A2A rows are the host row types", () => {
    expectTypeOf<PluginPerfStats>().toEqualTypeOf<HostPluginPerfStats>();
    expectTypeOf<PluginContributionTrustRow>().toEqualTypeOf<HostPluginContributionTrustRow>();
    expectTypeOf<HookTrustRow>().toEqualTypeOf<HostHookTrustRow>();
    expectTypeOf<HookTrustRow["hookType"]>().toEqualTypeOf<ScriptHookType>();
    expectTypeOf<RemoteA2AActionStatus>().toEqualTypeOf<HostRemoteA2AActionStatus>();
  });

  it("shared unions are spelled once", () => {
    expectTypeOf<ToolsToolCategory>().toEqualTypeOf<ToolCategory>();
    expectTypeOf<ToolsToolSource>().toEqualTypeOf<ToolSource>();
    expectTypeOf<RiskVerdict["level"]>().toEqualTypeOf<RiskLevel>();
    expectTypeOf<DeferredQueueEntry["source"]>().toEqualTypeOf<ToolSource>();
    expectTypeOf<DeferredQueueEntry["category"]>().toEqualTypeOf<ToolCategory>();
    expectTypeOf<DeferredQueueEntry["verdict"]["level"]>().toEqualTypeOf<RiskLevel>();
    expectTypeOf<DeferredEntry["resolvedScope"]>().toEqualTypeOf<DeferredGrantScope | undefined>();
  });

  it("ExecutionMode is one union across host, slash parser and renderer", () => {
    expectTypeOf<ExecutionMode>().toEqualTypeOf<HostExecutionMode>();
    expectTypeOf<PermissionModeCommand["mode"]>().toEqualTypeOf<HostExecutionMode>();
    expectTypeOf<ExecutionMode>().toEqualTypeOf<"default" | "strict" | "auto" | "allow">();
  });

  it("TranslateFn is the signature of both t entry points", () => {
    expectTypeOf(t).toEqualTypeOf<TranslateFn>();
    expectTypeOf<ReturnType<typeof useTranslation>["t"]>().toEqualTypeOf<TranslateFn>();
  });
});
