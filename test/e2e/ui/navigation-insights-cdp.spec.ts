import fs from "node:fs";
import path from "node:path";
import type { CDPSession } from "playwright";
import { test, expect } from "./fixtures.js";
import {
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { kstDateKey } from "../../../src/shared/kst-date.js";
import { makeTestT } from "./i18n.js";

const t = makeTestT("ko");

type NavigationProbe = {
  backDisabled: boolean | null;
  forwardDisabled: boolean | null;
  currentPath: string;
  breadcrumbDisplay: string | null;
  legacyBackCount: number;
  providerText: string;
  modelText: string;
};

function writeUsageAudit(lvisHome: string): void {
  const now = new Date();
  const dateKey = kstDateKey(now);
  const auditDir = path.join(lvisHome, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const rows = [
    {
      timestamp: now.toISOString(),
      sessionId: "navigation-insights-a",
      type: "turn",
      route: "openai-compatible/model-alpha",
      input: "provider and model insight fixture A",
      tokenUsage: { inputTokens: 1_000, outputTokens: 250 },
      usageByModel: [{
        vendorProvider: "openai-compatible",
        vendorModel: "model-alpha",
        tokenUsage: { inputTokens: 1_000, outputTokens: 250 },
      }],
      subscriptionUsage: [{
        provider: "codex",
        model: "subscription-alpha",
        source: "provider-reported",
        billable: false,
        inputTokens: 300,
        outputTokens: 50,
        totalTokens: 350,
      }],
    },
    {
      timestamp: new Date(now.getTime() + 1_000).toISOString(),
      sessionId: "navigation-insights-b",
      type: "turn",
      route: "lmstudio/model-beta",
      input: "provider and model insight fixture B",
      tokenUsage: { inputTokens: 700, outputTokens: 100 },
      usageByModel: [{
        vendorProvider: "lmstudio",
        vendorModel: "model-beta",
        tokenUsage: { inputTokens: 700, outputTokens: 100 },
      }],
    },
  ];
  fs.writeFileSync(
    path.join(auditDir, `${dateKey}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
}

async function readNavigationProbe(cdp: CDPSession): Promise<NavigationProbe> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const back = document.querySelector('[data-testid="view-path-back"]');
      const forward = document.querySelector('[data-testid="view-path-forward"]');
      const breadcrumb = document.querySelector('[data-testid="view-path-breadcrumb"]');
      const current = breadcrumb?.querySelector('[aria-current="page"]');
      const provider = document.querySelector('[data-testid="insights-provider-usage"]');
      const model = document.querySelector('[data-testid="insights-model-usage"]');
      return {
        backDisabled: back instanceof HTMLButtonElement ? back.disabled : null,
        forwardDisabled: forward instanceof HTMLButtonElement ? forward.disabled : null,
        currentPath: current?.textContent?.trim() ?? '',
        breadcrumbDisplay: breadcrumb ? getComputedStyle(breadcrumb).display : null,
        legacyBackCount: document.querySelectorAll(
          '[data-testid="main-content-back"], [data-testid="plugin-page-back"], [data-testid="page-shell-back"], [data-testid="settings-close"], [data-testid="settings-mobile-close"]'
        ).length,
        providerText: provider?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        modelText: model?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      };
    })()`,
    returnByValue: true,
  });
  return result.result.value as NavigationProbe;
}

async function attachCdpScreenshot(cdp: CDPSession, name: string): Promise<void> {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  expect(screenshot.data.length).toBeGreaterThan(20_000);
  await test.info().attach(name, {
    contentType: "image/png",
    body: Buffer.from(screenshot.data, "base64"),
  });
}

async function expectNoLegacyBack(cdp: CDPSession): Promise<void> {
  expect((await readNavigationProbe(cdp)).legacyBackCount).toBe(0);
}

async function selectSettingsTab(
  page: import("@playwright/test").Page,
  name: RegExp,
): Promise<void> {
  const tab = page.getByRole("tab", { name });
  if (!await tab.isVisible().catch(() => false)) {
    const mobileBack = page.getByTestId("settings-mobile-back");
    if (await mobileBack.isVisible().catch(() => false)) await mobileBack.click();
  }
  await page.getByRole("tab", { name }).click();
}

test.describe("navigation and monthly insights under CDP", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("uses one history navbar and shows monthly provider and model usage", async () => {
    const ctx = await launchSeededElectron({
      sessionTitle: "navigation and insights CDP",
      historyRows: [{
        index: 0,
        role: "user",
        content: "navigation and insights fixture",
        createdAt: Date.now() - 1_000,
      }],
    });
    const cdp = await ctx.page.context().newCDPSession(ctx.page);

    try {
      writeUsageAudit(ctx.lvisHome);
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");

      const home = await readNavigationProbe(cdp);
      expect(home.backDisabled).toBe(true);
      expect(home.forwardDisabled).toBe(true);
      expect(home.legacyBackCount).toBe(0);

      await ctx.page.getByTestId("toolbar-work-board").click();
      await expect(ctx.page.getByTestId("view-path-current-work-board")).toBeVisible();
      await expectNoLegacyBack(cdp);

      await ctx.page.getByTestId("sidebar-starred").click();
      await expect(ctx.page.getByTestId("view-path-current-insights")).toBeVisible();
      await expect(ctx.page.getByTestId("insights-monthly-usage-breakdown")).toBeVisible();
      await expect(ctx.page.getByTestId("insights-provider-usage")).toContainText("openai-compatible");
      await expect(ctx.page.getByTestId("insights-provider-usage")).toContainText("lmstudio");
      await expect(ctx.page.getByTestId("insights-provider-usage")).toContainText("codex");
      await expect(ctx.page.getByTestId("insights-model-usage")).toContainText("model-alpha");
      await expect(ctx.page.getByTestId("insights-model-usage")).toContainText("model-beta");
      await expect(ctx.page.getByTestId("insights-model-usage")).toContainText("subscription-alpha");

      const insights = await readNavigationProbe(cdp);
      expect(insights.backDisabled).toBe(false);
      expect(insights.forwardDisabled).toBe(true);
      expect(insights.currentPath).not.toBe("");
      expect(insights.legacyBackCount).toBe(0);
      expect(insights.providerText).toContain("openai-compatible");
      expect(insights.modelText).toContain("model-alpha");
      expect(insights.modelText).toContain("subscription-alpha");
      await attachCdpScreenshot(cdp, "navigation-insights-desktop-cdp.png");

      await ctx.page.getByTestId("view-path-back").click();
      await expect(ctx.page.getByTestId("view-path-current-work-board")).toBeVisible();
      const afterBack = await readNavigationProbe(cdp);
      expect(afterBack.forwardDisabled).toBe(false);
      expect(afterBack.legacyBackCount).toBe(0);

      await ctx.page.getByTestId("view-path-forward").click();
      await expect(ctx.page.getByTestId("view-path-current-insights")).toBeVisible();

      await ctx.page.getByTestId("sidebar-settings").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:llm")).toBeVisible();
      await selectSettingsTab(ctx.page, /Usage|사용량/);
      await expect(ctx.page.getByTestId("view-path-current-settings:usage")).toBeVisible();
      await expect(ctx.page.getByTestId("general-tab-card-plugin")).toBeVisible();
      await ctx.page.getByTestId("general-tab-card-plugin").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:plugin-config")).toBeVisible();
      await ctx.page.getByTestId("view-path-back").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:usage")).toBeVisible();
      await ctx.page.getByTestId("view-path-forward").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:plugin-config")).toBeVisible();
      await ctx.page.getByTestId("view-path-segment-settings").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:llm")).toBeVisible();
      await selectSettingsTab(ctx.page, /Permissions|권한/);
      await expect(ctx.page.getByTestId("view-path-current-settings:permissions")).toBeVisible();
      await ctx.page.getByTestId("view-path-segment-settings").click();
      await expect(ctx.page.getByTestId("view-path-current-settings:llm")).toBeVisible();
      await expect(ctx.page.getByRole("tabpanel", { name: /Model|모델/ })).toBeVisible();
      await expectNoLegacyBack(cdp);

      // A top-navbar departure must flush the inline Settings debounce before
      // unmount. Reopening reads the saved value from disk on a fresh mount.
      await ctx.page.getByTestId("sidebar-home").click();
      await expect(ctx.page.getByTestId("view-path-current-home")).toBeVisible();
      await ctx.page.getByTestId("sidebar-settings").click();
      await selectSettingsTab(ctx.page, /Chat|채팅/);
      const privacyToggle = ctx.page.getByRole("checkbox", {
        name: t("privacyTab.piiRedactToggleLabel"),
      });
      await expect(privacyToggle).toBeVisible();
      const nextPrivacyState = (await privacyToggle.getAttribute("aria-checked")) === "true"
        ? "false"
        : "true";
      await privacyToggle.click();
      // The first step replays Chat -> Model within Settings; the second exits
      // Settings to Home and exercises the unmount flush boundary.
      await ctx.page.getByTestId("view-path-back").click();
      await ctx.page.getByTestId("view-path-back").click();
      await expect(ctx.page.getByTestId("view-path-current-home")).toBeVisible();
      await ctx.page.getByTestId("sidebar-settings").click();
      await selectSettingsTab(ctx.page, /Chat|채팅/);
      await expect(ctx.page.getByRole("checkbox", {
        name: t("privacyTab.piiRedactToggleLabel"),
      })).toHaveAttribute("aria-checked", nextPrivacyState);

      await ctx.page.getByTestId("sidebar-starred").click();
      await expect(ctx.page.getByTestId("view-path-current-insights")).toBeVisible();
      await ctx.page.setViewportSize({ width: 460, height: 900 });
      await expect(ctx.page.getByTestId("view-path-back")).toBeVisible();
      await expect(ctx.page.getByTestId("view-path-forward")).toBeVisible();
      await expect(ctx.page.getByTestId("view-path-breadcrumb")).toBeHidden();
      // ResizeObserver/month range effects can briefly re-enter loading while
      // the narrow layout settles; sample CDP only after the same visible data
      // contract has returned.
      await expect(ctx.page.getByTestId("insights-provider-usage")).toContainText(
        "openai-compatible",
      );
      await expect(ctx.page.getByTestId("insights-model-usage")).toContainText("model-beta");
      const narrow = await readNavigationProbe(cdp);
      expect(narrow.breadcrumbDisplay).toBe("none");
      expect(narrow.legacyBackCount).toBe(0);
      expect(narrow.providerText).toContain("openai-compatible");
      expect(narrow.modelText).toContain("model-beta");
      await attachCdpScreenshot(cdp, "navigation-insights-narrow-cdp.png");
    } finally {
      await cdp.detach().catch(() => {});
      await teardownSeededElectron(ctx);
    }
  });
});
