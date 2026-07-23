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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.skip(!E2E_ENABLED, "set M4_E2E=1 to run the live Marketplace Electron lifecycle");
test.skip(!builtMainExists(), "build the Electron app before running this spec");

test("publish, approve, install, update, rollback, disable, re-enable, and uninstall atomically", async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
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
    const skillNames = () => ctx.page.evaluate(async () => {
      const api = globalThis as unknown as { lvisApi: { listSkills(): Promise<{ skills: Array<{ name: string }> }> } };
      return (await api.lvisApi.listSkills()).skills.map((skill) => skill.name);
    });
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
    const approveExecutableContributions = async () => {
      await expect(setContributionTrust("hook", "audit")).resolves.toMatchObject({ ok: true });
      await expect(setContributionTrust("mcpServer", "echo")).resolves.toMatchObject({ ok: true });
    };
    const baselineMcpCount = (await runtimeCounts()).mcps;

    await packageAction.click();
    await expect.poll(async () => (await cards()).find((card) => card.id === slug)?.version)
      .toBe("1.0.0");
    expect(await skillNames()).toContain(`plugin:${slug}:lifecycle`);
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
    expect(await cards()).toContainEqual(expect.objectContaining({ id: slug, version: "2.0.0" }));
    const v2Pending = await contributionTrust();
    expect(v2Pending.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", pluginVersion: "2.0.0", status: "approval_required" }),
      expect.objectContaining({ kind: "mcpServer", pluginVersion: "2.0.0", status: "approval_required" }),
    ]));
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount);
    await approveExecutableContributions();
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "updated",
      version: "2.0.0",
      executableTrustReapproved: true,
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
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount + 1);
    expect((await contributionTrust()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook", pluginVersion: "1.0.0", status: "approved" }),
      expect.objectContaining({ kind: "mcpServer", pluginVersion: "1.0.0", status: "approved" }),
    ]));
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "rolled-back",
      version: "1.0.0",
      executableTrustRestored: true,
    });

    await expect(setEnabled(false)).resolves.toMatchObject({ ok: true, enabled: false });
    expect(await cards()).toContainEqual(expect.objectContaining({
      id: slug,
      active: false,
      runtimeLoaded: false,
      loadStatus: "disabled",
    }));
    expect(await skillNames()).not.toContain(`plugin:${slug}:lifecycle`);
    expect((await contributionTrust()).rows).toEqual([]);
    await expect.poll(async () => (await runtimeCounts()).mcps).toBe(baselineMcpCount);
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "disabled",
      runtimeLoaded: false,
      hookRows: 0,
      mcpConnected: false,
    });

    await expect(setEnabled(true)).resolves.toMatchObject({ ok: true, enabled: true });
    expect(await skillNames()).toContain(`plugin:${slug}:lifecycle`);
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
    expect(await callLifecycleTool("hook_probe")).toMatchObject({ ok: false });
    transitions.push({
      state: "re-enabled",
      version: "1.0.0",
      hookExecuted: true,
      mcpConnected: true,
    });

    await packageAction.click();
    await expect.poll(async () => (await cards()).some((card) => card.id === slug)).toBe(false);
    expect(await skillNames()).not.toContain(`plugin:${slug}:lifecycle`);
    const generationRoot = join(ctx.lvisHome, "plugins", ".cache", slug, "generations");
    await expect.poll(
      () => existsSync(generationRoot) ? readdirSync(generationRoot) : [],
      { message: "retired plugin generations must be removed after uninstall" },
    ).toEqual([]);
    expect(existsSync(join(ctx.lvisHome, "plugins", slug))).toBe(false);
    const trustRowsAfterUninstall = (await contributionTrust()).rows;
    const skillsAfterUninstall = await skillNames();
    const mcpCountAfterUninstall = (await runtimeCounts()).mcps;
    const retainedGenerations = existsSync(generationRoot)
      ? readdirSync(generationRoot)
      : [];
    const pluginRootExists = existsSync(join(ctx.lvisHome, "plugins", slug));
    const zeroOrphans =
      trustRowsAfterUninstall.length === 0 &&
      !skillsAfterUninstall.includes(`plugin:${slug}:lifecycle`) &&
      mcpCountAfterUninstall === baselineMcpCount &&
      retainedGenerations.length === 0 &&
      !pluginRootExists;
    expect(zeroOrphans).toBe(true);
    transitions.push({
      state: "uninstalled",
      trustRows: trustRowsAfterUninstall.length,
      retainedGenerations: retainedGenerations.length,
      mcpConnected: false,
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
