import { test, expect } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

test.describe("chat no-API-key layout", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  let ctx: SeededElectronContext;

  test.afterEach(async () => {
    if (ctx) await teardownSeededElectron(ctx);
  });

  test("keeps the API-key-required card in the transcript and away from the composer", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "lvis-no-api-key-layout-user-data-",
      homePrefix: "lvis-no-api-key-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1040, height: 360 });

    const card = ctx.page.locator('[data-testid="chat-view:no-api-key-card"]');
    const composer = ctx.page.locator('[data-testid="composer-input-bar"]');
    const projectSelector = ctx.page.locator('[data-testid="composer-project-selector-slot"]');
    await expect(card).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(projectSelector).toBeVisible();

    const metrics = await ctx.page.evaluate(() => {
      const toBox = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        };
      };
      const cardEl = document.querySelector('[data-testid="chat-view:no-api-key-card"]');
      const cardBox = toBox('[data-testid="chat-view:no-api-key-card"]');
      const composerBox = toBox('[data-testid="composer-input-bar"]');
      const composerDock = document.querySelector("[data-composer-placement]");
      const placement = composerDock?.getAttribute("data-composer-placement");
      const lift = composerDock?.getAttribute("data-composer-centered-lift");
      const marginBottom = composerDock ? Number.parseFloat(getComputedStyle(composerDock).marginBottom) : Number.NaN;
      if (!cardBox || !composerBox) return null;
      const overlaps = !(
        cardBox.right <= composerBox.left ||
        cardBox.left >= composerBox.right ||
        cardBox.bottom <= composerBox.top ||
        cardBox.top >= composerBox.bottom
      );
      return {
        placement,
        lift,
        marginBottom,
        overlaps,
        cardBox,
        composerBox,
        cardInsideScroll: Boolean(cardEl?.closest(".lvis-chat-scroll")),
        gap: composerBox.top - cardBox.bottom,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("center");
    expect(metrics?.lift).toBe("compact");
    expect(metrics?.marginBottom, JSON.stringify(metrics)).toBeGreaterThan(0);
    expect(metrics?.cardInsideScroll).toBe(true);
    expect(metrics?.overlaps, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.gap, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0);
  });

  test("lifts the no-key new-session composer on a full-height viewport", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "lvis-no-api-key-tall-layout-user-data-",
      homePrefix: "lvis-no-api-key-tall-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1076, height: 798 });

    const card = ctx.page.locator('[data-testid="chat-view:no-api-key-card"]');
    const composer = ctx.page.locator('[data-testid="composer-input-bar"]');
    const projectSelector = ctx.page.locator('[data-testid="composer-project-selector-slot"]');
    await expect(card).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(projectSelector).toBeVisible();

    const metrics = await ctx.page.evaluate(() => {
      const toBox = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          height: rect.height,
        };
      };
      const cardBox = toBox('[data-testid="chat-view:no-api-key-card"]');
      const composerBox = toBox('[data-testid="composer-input-bar"]');
      const composerDock = document.querySelector("[data-composer-placement]");
      if (!cardBox || !composerBox) return null;
      const overlaps = !(
        cardBox.right <= composerBox.left ||
        cardBox.left >= composerBox.right ||
        cardBox.bottom <= composerBox.top ||
        cardBox.top >= composerBox.bottom
      );
      return {
        viewportHeight: window.innerHeight,
        placement: composerDock?.getAttribute("data-composer-placement"),
        lift: composerDock?.getAttribute("data-composer-centered-lift"),
        overlaps,
        cardBox,
        composerBox,
        gap: composerBox.top - cardBox.bottom,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("center");
    expect(metrics?.lift).toBe("compact");
    expect(metrics?.overlaps, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.gap, JSON.stringify(metrics)).toBeGreaterThanOrEqual(0);
    expect(metrics?.composerBox.top, JSON.stringify(metrics)).toBeLessThan(
      (metrics?.viewportHeight ?? 0) * 0.72,
    );
  });
});
