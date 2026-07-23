import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { mergeEvidenceFile } from "../evidence-file.js";
import {
  approvePendingPlugin,
  buildPluginZip,
  publishPlugin,
} from "../marketplace-e2e-fixture.js";
import {
  buildE2eBaseSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { openSettingsWindow } from "./settings-window.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";
const ADMIN_KEY = process.env.MARKETPLACE_ADMIN_KEY ?? "";
const EVIDENCE_PATH = process.env.BUNDLE_E2E_EVIDENCE_PATH ?? "";

type BundleSnapshot = {
  ok: true;
  active: {
    version: string;
    generationId: string;
    artifactGenerationId: string;
  } | null;
  skill: {
    name: string;
    body: string;
    owner: {
      pluginId: string;
      pluginVersion: string;
      generationId: string;
      localId: string;
      fingerprint: string;
    };
  } | null;
  tools: Array<{
    name: string;
    source: "plugin" | "mcp";
    version: string;
    pluginId?: string;
    mcpServerId?: string;
    generationId?: string;
  }>;
};

type McpProcessProbe = {
  echo: string;
  version: string;
  pid: number;
  processIdentity: string;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test.skip(!E2E_ENABLED, "set M4_E2E=1 to run the live Marketplace Electron lifecycle");
test.skip(!builtMainExists(), "build the Electron app before running this spec");

test("publish, approve, install, update, rollback, disable, re-enable, and uninstall atomically", async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  if (!PUBLISHER_KEY || !ADMIN_KEY) {
    throw new Error("MARKETPLACE_PUBLISHER_KEY and MARKETPLACE_ADMIN_KEY are required");
  }

  const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const managedSlug = `m4-approval-${suffix}`;
  const slug = `m4-lifecycle-${suffix}`;
  const v1 = buildPluginZip(slug, "1.0.0", { bundledContributions: true });
  const v2 = buildPluginZip(slug, "2.0.0", { bundledContributions: true });
  const managed = buildPluginZip(managedSlug, "1.0.0", { installPolicy: "admin" });
  const transitions: Array<Record<string, unknown>> = [];

  await publishPlugin(BASE_URL, ADMIN_KEY, managedSlug, "1.0.0", managed);
  const hiddenBeforeApproval = await fetch(`${BASE_URL}/api/v1/plugins/${managedSlug}`);
  expect(hiddenBeforeApproval.status).toBe(404);
  const approval = await approvePendingPlugin(BASE_URL, ADMIN_KEY, managedSlug, "1.0.0");
  expect(approval.approval_state).toBe("approved");
  expect((await fetch(`${BASE_URL}/api/v1/plugins/${managedSlug}`)).status).toBe(200);

  await publishPlugin(BASE_URL, PUBLISHER_KEY, slug, "1.0.0", v1);
  const settings = buildE2eBaseSettings(true, "en");
  settings.marketplace = {
    backend: "real-cloud",
    cloudBaseUrl: BASE_URL,
    cloudAllowPrivateNetwork: true,
    updateCheckEnabled: false,
    updateCheckIntervalMs: 0,
  };
  const ctx = await launchSeededElectron({
    historyRows: [],
    settings,
    userDataPrefix: "lvis-marketplace-live-user-data-",
    homePrefix: "lvis-marketplace-live-home-",
  });

  try {
    const marketplace = await openSettingsWindow(ctx.app, ctx.page, "marketplace");
    const packageAction = marketplace.getByTestId(`marketplace:action:${slug}`);
    await expect(packageAction).toBeVisible();
    const cards = () => ctx.page.evaluate(async () => {
      const api = globalThis as unknown as { lvisApi: { listPluginCards(): Promise<Array<Record<string, unknown>>> } };
      return api.lvisApi.listPluginCards();
    });
    const bundleSnapshot = () => ctx.page.evaluate(async (
      { pluginId, skillLocalId },
    ) => {
      const api = globalThis as unknown as {
        lvisApi: {
          e2ePluginBundleSnapshot(
            id: string,
            localId: string,
          ): Promise<BundleSnapshot>;
        };
      };
      return api.lvisApi.e2ePluginBundleSnapshot(pluginId, skillLocalId);
    }, { pluginId: slug, skillLocalId: "lifecycle" });
    const setEnabled = (enabled: boolean) => ctx.page.evaluate(async ({ pluginId, enabled }) => {
      const api = globalThis as unknown as {
        lvisApi: { setPluginEnabled(id: string, active: boolean): Promise<unknown> };
      };
      return api.lvisApi.setPluginEnabled(pluginId, enabled);
    }, { pluginId: slug, enabled });
    const contributionTrust = () => ctx.page.evaluate(async (pluginId) => {
      const api = globalThis as unknown as {
        lvisApi: {
          listPluginContributionTrust(id: string): Promise<{
            ok: boolean;
            rows: Array<Record<string, unknown>>;
          }>;
        };
      };
      return api.lvisApi.listPluginContributionTrust(pluginId);
    }, slug);
    const setContributionTrust = (kind: "hook" | "mcpServer", localId: string) =>
      ctx.page.evaluate(async ({ pluginId, kind, localId }) => {
        const api = globalThis as unknown as {
          lvisApi: {
            setPluginContributionTrust(input: {
              pluginId: string;
              kind: "hook" | "mcpServer";
              localId: string;
              approved: boolean;
            }): Promise<Record<string, unknown>>;
          };
        };
        return api.lvisApi.setPluginContributionTrust({
          pluginId,
          kind,
          localId,
          approved: true,
        });
      }, { pluginId: slug, kind, localId });
    const runtimeCounts = () => ctx.page.evaluate(async () => {
      const api = globalThis as unknown as {
        lvisApi: { getRuntimeCounts(): Promise<{ tools: number; plugins: number; mcps: number }> };
      };
      return api.lvisApi.getRuntimeCounts();
    });
    const callLifecycleTool = (operation: "get_version" | "hook_probe") =>
      ctx.page.evaluate(async ({ name, operation }) => {
        const api = globalThis as unknown as {
          lvisApi: {
            callPluginMethod(
              method: string,
              payload: Record<string, unknown>,
            ): Promise<Record<string, unknown>>;
          };
        };
        return api.lvisApi.callPluginMethod(name, { operation });
      }, { name: `${slug.replace(/-/g, "_")}_read`, operation });
    const permissionAudit = () => ctx.page.evaluate(async () => {
      const api = globalThis as unknown as {
        lvisApi: {
          permissions: {
            auditShow(last: number): Promise<{
              ok: boolean;
              entries: Array<Record<string, unknown>>;
            }>;
          };
        };
      };
      return api.lvisApi.permissions.auditShow(250);
    });
    const assertBundleVersion = async (version: string) => {
      const snapshot = await bundleSnapshot();
      expect(snapshot.ok).toBe(true);
      expect(snapshot.active).toMatchObject({ version });
      expect(snapshot.active?.generationId).toMatch(/^[a-f0-9-]{16,}$/);
      expect(snapshot.active?.artifactGenerationId).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.skill).toMatchObject({
        name: `plugin:${slug}:lifecycle`,
        owner: {
          pluginId: slug,
          pluginVersion: version,
          generationId: snapshot.active?.generationId,
          localId: "lifecycle",
        },
      });
      expect(snapshot.skill?.body).toContain(`fixture-version:${version}`);
      expect(snapshot.skill?.owner.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.tools).toContainEqual(expect.objectContaining({
        name: `${slug.replace(/-/g, "_")}_read`,
        source: "plugin",
        pluginId: slug,
        generationId: snapshot.active?.generationId,
      }));
      return snapshot;
    };
    const callBundledMcp = async (
      version: string,
      options: { approvalExpected?: boolean } = {},
    ) => {
      const snapshot = await bundleSnapshot();
      const mcpTool = snapshot.tools.find((tool) => tool.source === "mcp");
      expect(mcpTool).toMatchObject({
        source: "mcp",
        generationId: snapshot.active?.generationId,
      });
      expect(mcpTool?.mcpServerId).toMatch(/^plugin_[a-f0-9]{24}$/);
      const auditBefore = await permissionAudit();
      const priorAuditIds = new Set(
        auditBefore.entries.map((entry) => String(entry.auditId)),
      );
      const probe = `${slug}:${version}:${snapshot.active?.generationId}`;
      const invocation = ctx.page.evaluate(async (
        { serverId, text },
      ) => {
        const api = globalThis as unknown as {
          lvisApi: {
            mcp: {
              callTool(
                serverId: string,
                name: string,
                args: Record<string, unknown>,
              ): Promise<{
                ok: boolean;
                result?: unknown;
                error?: string;
                message?: string;
              }>;
            };
          };
        };
        return api.lvisApi.mcp.callTool(
          serverId,
          "bundle_echo",
          { text },
        );
      }, { serverId: mcpTool!.mcpServerId!, text: probe });

      const approvalDialog = ctx.page.getByTestId("tool-approval-dialog");
      const approvalVisible = await approvalDialog
        .waitFor({
          state: "visible",
          timeout: options.approvalExpected ? 10_000 : 1_000,
        })
        .then(() => true)
        .catch(() => false);
      if (options.approvalExpected) {
        expect(approvalVisible).toBe(true);
      }
      if (approvalVisible) {
        const justification = ctx.page.getByTestId("nl-justification-input");
        if (await justification.isVisible().catch(() => false)) {
          await justification.fill("Verify the installed bundle MCP generation.");
        }
        const approve = ctx.page.getByTestId("approve-button");
        await expect(approve).toBeEnabled();
        await approve.click();
      }

      const outcome = await invocation;
      expect(outcome).toMatchObject({ ok: true });
      expect(typeof outcome.result).toBe("string");
      const processProbe = JSON.parse(String(outcome.result)) as McpProcessProbe;
      expect(processProbe).toMatchObject({
        echo: probe,
        version,
      });
      expect(processProbe.pid).toBeGreaterThan(0);
      expect(processProbe.processIdentity).toMatch(
        new RegExp(`^${processProbe.pid}:\\d+:\\d+$`),
      );
      expect(processIsAlive(processProbe.pid)).toBe(true);
      const snapshotAfterCall = await bundleSnapshot();
      expect(snapshotAfterCall.active?.generationId).toBe(
        snapshot.active?.generationId,
      );
      expect(snapshotAfterCall.tools).toContainEqual(expect.objectContaining({
        name: mcpTool!.name,
        source: "mcp",
        mcpServerId: mcpTool!.mcpServerId,
        generationId: snapshot.active?.generationId,
      }));

      const auditAfter = await permissionAudit();
      const invocationAudit = auditAfter.entries.find((entry) =>
        !priorAuditIds.has(String(entry.auditId)) &&
        entry.decision === "allow" &&
        entry.tool === mcpTool!.name &&
        entry.source === "mcp" &&
        typeof entry.toolUseId === "string"
      );
      expect(invocationAudit).toMatchObject({
        decision: "allow",
        tool: mcpTool!.name,
        source: "mcp",
      });
      expect(invocationAudit?.toolUseId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i,
      );

      return {
        process: processProbe,
        identity: {
          version: snapshot.active!.version,
          generationId: snapshot.active!.generationId,
          artifactGenerationId: snapshot.active!.artifactGenerationId,
          mcpServerId: mcpTool!.mcpServerId!,
          registryTool: mcpTool!.name,
          auditId: String(invocationAudit!.auditId),
          toolUseId: String(invocationAudit!.toolUseId),
        },
      };
    };
    const expectProcessTerminated = async (probe: McpProcessProbe) => {
      await expect.poll(
        () => processIsAlive(probe.pid),
        {
          message: `MCP process ${probe.processIdentity} must terminate`,
          timeout: 10_000,
        },
      ).toBe(false);
    };
    const approveExecutableContributions = async () => {
      await expect(setContributionTrust("hook", "audit")).resolves.toMatchObject({ ok: true });
      await expect(setContributionTrust("mcpServer", "echo")).resolves.toMatchObject({ ok: true });
    };
    const baselineMcpCount = (await runtimeCounts()).mcps;
    let activeMcpProbe: Awaited<ReturnType<typeof callBundledMcp>> | null = null;

    await packageAction.click();
    await expect.poll(async () => (await cards()).find((card) => card.id === slug)?.version)
      .toBe("1.0.0");
    await assertBundleVersion("1.0.0");
    expect(await cards()).toContainEqual(expect.objectContaining({
      id: slug,
      version: "1.0.0",
      active: true,
      runtimeLoaded: true,
    }));
    const v1Pending = await contributionTrust();
    expect(v1Pending.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "hook",
        localId: "audit",
        pluginVersion: "1.0.0",
        status: "approval_required",
      }),
      expect.objectContaining({
        kind: "mcpServer",
        localId: "echo",
        pluginVersion: "1.0.0",
        status: "approval_required",
      }),
    ]));
    await expect(callLifecycleTool("hook_probe")).resolves.toMatchObject({ ok: true });
    await approveExecutableContributions();
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    activeMcpProbe = await callBundledMcp("1.0.0", {
      approvalExpected: true,
    });
    const v1Approved = await contributionTrust();
    expect(v1Approved.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", localId: "audit", status: "approved" }),
      expect.objectContaining({ kind: "mcpServer", localId: "echo", status: "approved" }),
    ]));
    for (const row of v1Approved.rows) {
      expect(row.generationId).toMatch(/^[a-f0-9]{64}$/);
      expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    const hookDeniedV1 = await callLifecycleTool("hook_probe");
    expect(hookDeniedV1).toMatchObject({ ok: false });
    expect(JSON.stringify(hookDeniedV1)).toContain("marketplace lifecycle hook probe");
    transitions.push({
      state: "installed",
      version: "1.0.0",
      hookExecuted: true,
      mcpConnected: true,
      mcpIdentity: activeMcpProbe.identity,
    });

    await publishPlugin(BASE_URL, PUBLISHER_KEY, slug, "2.0.0", v2);
    await ctx.app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send("marketplace:updates-available", payload);
    }, [{
      pluginId: slug,
      pluginName: "Marketplace E2E Plugin",
      installedVersion: "1.0.0",
      latestVersion: "2.0.0",
    }]);
    await expect(marketplace.getByTestId("marketplace-update-banner")).toBeVisible();
    await marketplace.getByTestId("marketplace-update-action").click();
    await expect.poll(async () => (await cards()).find((card) => card.id === slug)?.version)
      .toBe("2.0.0");
    await expectProcessTerminated(activeMcpProbe.process);
    await assertBundleVersion("2.0.0");
    expect(await cards()).toContainEqual(expect.objectContaining({ id: slug, version: "2.0.0" }));
    const v2Pending = await contributionTrust();
    expect(v2Pending.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", pluginVersion: "2.0.0", status: "approval_required" }),
      expect.objectContaining({ kind: "mcpServer", pluginVersion: "2.0.0", status: "approval_required" }),
    ]));
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount);
    await approveExecutableContributions();
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    activeMcpProbe = await callBundledMcp("2.0.0");
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "updated",
      version: "2.0.0",
      executableTrustReapproved: true,
      mcpIdentity: activeMcpProbe.identity,
    });

    const rollbackAction = marketplace.getByTestId(`marketplace:rollback:${slug}`);
    await expect(rollbackAction).toBeVisible();
    await rollbackAction.click();
    await expect(rollbackAction).toBeDisabled();
    await expect(rollbackAction).toBeEnabled();
    await expect(marketplace.getByText(/^Operation failed:/)).toHaveCount(0);
    await expect.poll(async () => (await cards()).find((card) => card.id === slug))
      .toMatchObject({
        id: slug,
        version: "1.0.0",
        active: true,
        runtimeLoaded: true,
      });
    await expectProcessTerminated(activeMcpProbe.process);
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    await assertBundleVersion("1.0.0");
    activeMcpProbe = await callBundledMcp("1.0.0");
    expect((await contributionTrust()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", pluginVersion: "1.0.0", status: "approved" }),
      expect.objectContaining({ kind: "mcpServer", pluginVersion: "1.0.0", status: "approved" }),
    ]));
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "rolled-back",
      version: "1.0.0",
      executableTrustRestored: true,
      mcpIdentity: activeMcpProbe.identity,
    });

    await expect(setEnabled(false)).resolves.toMatchObject({ ok: true, enabled: false });
    await expectProcessTerminated(activeMcpProbe.process);
    expect(await cards()).toContainEqual(expect.objectContaining({
      id: slug,
      active: false,
      runtimeLoaded: false,
      loadStatus: "disabled",
    }));
    expect(await bundleSnapshot()).toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
    });
    expect((await contributionTrust()).rows).toEqual([]);
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount);
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "disabled",
      runtimeLoaded: false,
      hookRows: 0,
      mcpConnected: false,
      registryOwnerRows: 0,
      terminatedProcessIdentity: activeMcpProbe.process.processIdentity,
    });

    await expect(setEnabled(true)).resolves.toMatchObject({ ok: true, enabled: true });
    await assertBundleVersion("1.0.0");
    expect(await cards()).toContainEqual(expect.objectContaining({
      id: slug,
      version: "1.0.0",
      active: true,
      runtimeLoaded: true,
    }));
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    expect((await contributionTrust()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", status: "approved" }),
      expect.objectContaining({ kind: "mcpServer", status: "approved" }),
    ]));
    activeMcpProbe = await callBundledMcp("1.0.0");
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "re-enabled",
      version: "1.0.0",
      hookExecuted: true,
      mcpConnected: true,
      mcpIdentity: activeMcpProbe.identity,
    });

    await packageAction.click();
    await expect.poll(async () => (await cards()).some((card) => card.id === slug)).toBe(false);
    await expectProcessTerminated(activeMcpProbe.process);
    const snapshotAfterUninstall = await bundleSnapshot();
    expect(snapshotAfterUninstall).toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
    });
    const generationRoot = join(ctx.lvisHome, "plugins", ".cache", slug, "generations");
    await expect.poll(
      () => existsSync(generationRoot) ? readdirSync(generationRoot) : [],
      { message: "retired plugin generations must be removed after uninstall" },
    ).toEqual([]);
    expect(existsSync(join(ctx.lvisHome, "plugins", slug))).toBe(false);
    const trustRowsAfterUninstall = (await contributionTrust()).rows;
    const mcpCountAfterUninstall = (await runtimeCounts()).mcps;
    const retainedGenerations = existsSync(generationRoot)
      ? readdirSync(generationRoot)
      : [];
    const pluginRootExists = existsSync(join(ctx.lvisHome, "plugins", slug));
    const zeroOrphans =
      trustRowsAfterUninstall.length === 0 &&
      snapshotAfterUninstall.active === null &&
      snapshotAfterUninstall.skill === null &&
      snapshotAfterUninstall.tools.length === 0 &&
      mcpCountAfterUninstall === baselineMcpCount &&
      retainedGenerations.length === 0 &&
      !pluginRootExists;
    expect(zeroOrphans).toBe(true);
    transitions.push({
      state: "uninstalled",
      trustRows: trustRowsAfterUninstall.length,
      retainedGenerations: retainedGenerations.length,
      mcpConnected: false,
      registryOwnerRows: snapshotAfterUninstall.tools.length,
      terminatedProcessIdentity: activeMcpProbe.process.processIdentity,
    });

    mergeEvidenceFile(EVIDENCE_PATH, {
      liveLifecycle: {
        hostSha: process.env.HOST_SHA ?? null,
        marketplaceSha: process.env.MARKETPLACE_SHA ?? null,
        sdkSha: process.env.SDK_SHA ?? null,
        epApiSha: process.env.EP_API_SHA ?? null,
        approval: { slug: managedSlug, hiddenBeforeApproval: true, state: approval.approval_state },
        artifact: { slug, hashes: { "1.0.0": sha256(v1), "2.0.0": sha256(v2) }, signerId: "poc-v1" },
        transitions,
        zeroOrphans,
      },
    });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
