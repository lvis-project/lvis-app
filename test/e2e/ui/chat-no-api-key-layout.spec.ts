import { test, expect } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

/**
 * The no-API-key affordance used to be a transcript card claiming
 * `min-h-[min(12rem,36vh)]`. Its height forced the centered composer to shrink
 * its lift (`data-composer-centered-lift="compact"`), so an empty conversation
 * never looked centered while a key was missing. It is now a zero-height chip in
 * the composer's reserved top strip, mirrored across from the project selector.
 *
 * These tests pin that: the card is gone, the chip sits in the strip (not in the
 * scrolling transcript), and the dock keeps its FULL lift. The lift is the sharp
 * assertion — the retired `compact` variant resolved to `mb-48` (192px) at
 * >=720px tall, whereas the full lift is `clamp(9rem,32vh,20rem)` (~255px at
 * 798px). Measuring `margin-bottom` therefore distinguishes them numerically,
 * not just by an attribute that a future refactor might drop.
 */
test.describe("chat no-API-key layout", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  let ctx: SeededElectronContext;

  test.afterEach(async () => {
    if (ctx) await teardownSeededElectron(ctx);
  });

  test("puts the no-key chip in the composer strip, not the transcript", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "lvis-no-api-key-layout-user-data-",
      homePrefix: "lvis-no-api-key-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1040, height: 360 });

    const chip = ctx.page.locator('[data-testid="composer-api-key-chip"]');
    const composer = ctx.page.locator('[data-testid="composer-input-bar"]');
    const projectSelector = ctx.page.locator('[data-testid="composer-project-selector-slot"]');
    await expect(chip).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(projectSelector).toBeVisible();
    await expect(ctx.page.locator('[data-testid="chat-view:no-api-key-card"]')).toHaveCount(0);

    const metrics = await ctx.page.evaluate(() => {
      const toBox = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, height: rect.height };
      };
      const chipEl = document.querySelector('[data-testid="composer-api-key-chip"]');
      const chipBox = toBox('[data-testid="composer-api-key-chip"]');
      const selectorBox = toBox('[data-testid="composer-project-selector-slot"]');
      const composerBox = toBox('[data-testid="composer-input-bar"]');
      const composerDock = document.querySelector("[data-composer-placement]");
      if (!chipBox || !selectorBox || !composerBox) return null;
      const overlapsComposer = !(
        chipBox.right <= composerBox.left ||
        chipBox.left >= composerBox.right ||
        chipBox.bottom <= composerBox.top ||
        chipBox.top >= composerBox.bottom
      );
      return {
        placement: composerDock?.getAttribute("data-composer-placement"),
        hasLiftAttr: composerDock?.hasAttribute("data-composer-centered-lift") ?? false,
        chipInsideScroll: Boolean(chipEl?.closest(".lvis-chat-scroll")),
        overlapsComposer,
        // Mirrored: the chip starts to the right of where the selector ends.
        chipRightOfSelector: chipBox.left >= selectorBox.right,
        // Both live in the strip directly above the composer card.
        chipAboveComposer: chipBox.bottom <= composerBox.top,
        sameStrip: Math.abs(chipBox.top - selectorBox.top) <= 12,
        composerBottom: composerBox.bottom,
        viewportHeight: window.innerHeight,
        chipBox,
        selectorBox,
        composerBox,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("center");
    expect(metrics?.hasLiftAttr, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.chipInsideScroll).toBe(false);
    expect(metrics?.overlapsComposer, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.chipRightOfSelector, JSON.stringify(metrics)).toBe(true);
    expect(metrics?.chipAboveComposer, JSON.stringify(metrics)).toBe(true);
    expect(metrics?.sameStrip, JSON.stringify(metrics)).toBe(true);
    // Even on a short viewport the composer stays fully on screen.
    expect(metrics?.composerBottom, JSON.stringify(metrics)).toBeLessThanOrEqual(
      metrics?.viewportHeight ?? 0,
    );
  });

  test("keeps the full centered lift on a tall viewport when no key is set", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "lvis-no-api-key-tall-layout-user-data-",
      homePrefix: "lvis-no-api-key-tall-layout-home-",
    });

    await ctx.page.setViewportSize({ width: 1076, height: 798 });

    await expect(ctx.page.locator('[data-testid="composer-api-key-chip"]')).toBeVisible();
    await expect(ctx.page.locator('[data-testid="composer-input-bar"]')).toBeVisible();

    // The dock animates its margin (`transition-[margin,transform] duration-300`),
    // and a viewport resize restarts that transition — sampling immediately reads
    // a mid-flight value. Poll until it settles.
    //
    // Full lift is `mb-[clamp(9rem,32vh,20rem)]` = clamp(144px, .32 * vh, 320px),
    // where `vh` is the CSS viewport (`documentElement.clientHeight`), not
    // `window.innerHeight`. The retired `compact` variant resolved to mb-32
    // (128px) / mb-48 (192px) via min-height media queries, so matching the
    // computed clamp proves the full lift is applied and no `compact` path
    // survived.
    await expect.poll(
      async () =>
        ctx.page.evaluate(() => {
          const dock = document.querySelector("[data-composer-placement]");
          if (!dock) return null;
          const cssVh = document.documentElement.clientHeight;
          const expected = Math.min(Math.max(144, cssVh * 0.32), 320);
          const actual = Number.parseFloat(getComputedStyle(dock).marginBottom);
          return Math.abs(actual - expected) <= 1;
        }),
      { timeout: 5_000, message: "composer dock never settled at the full centered lift" },
    ).toBe(true);

    const metrics = await ctx.page.evaluate(() => {
      const composerDock = document.querySelector("[data-composer-placement]");
      const composerEl = document.querySelector('[data-testid="composer-input-bar"]');
      if (!composerDock || !composerEl) return null;
      return {
        viewportHeight: window.innerHeight,
        cssViewportHeight: document.documentElement.clientHeight,
        placement: composerDock.getAttribute("data-composer-placement"),
        hasLiftAttr: composerDock.hasAttribute("data-composer-centered-lift"),
        marginBottom: Number.parseFloat(getComputedStyle(composerDock).marginBottom),
        composerTop: composerEl.getBoundingClientRect().top,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics?.placement).toBe("center");
    expect(metrics?.hasLiftAttr, JSON.stringify(metrics)).toBe(false);
    expect(metrics?.composerTop, JSON.stringify(metrics)).toBeLessThan(
      (metrics?.viewportHeight ?? 0) * 0.72,
    );
  });

  test("chip popover preserves both destinations from the retired card", async () => {
    ctx = await launchSeededElectron({
      historyRows: [],
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      userDataPrefix: "lvis-no-api-key-popover-user-data-",
      homePrefix: "lvis-no-api-key-popover-home-",
    });

    await ctx.page.setViewportSize({ width: 1076, height: 798 });

    const chip = ctx.page.locator('[data-testid="composer-api-key-chip"]');
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:settings"]')).toBeVisible();
    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:marketplace"]')).toBeVisible();

    // The popover is an overlay: opening it must not move the composer.
    const composerTopBefore = await ctx.page.evaluate(() =>
      document.querySelector('[data-testid="composer-input-bar"]')!.getBoundingClientRect().top,
    );
    await ctx.page.keyboard.press("Escape");
    await expect(ctx.page.locator('[data-testid="composer-api-key-chip:settings"]')).toHaveCount(0);
    const composerTopAfter = await ctx.page.evaluate(() =>
      document.querySelector('[data-testid="composer-input-bar"]')!.getBoundingClientRect().top,
    );
    expect(Math.abs(composerTopAfter - composerTopBefore)).toBeLessThanOrEqual(1);
  });
});
