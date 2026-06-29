import { test, expect, type Page } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

const CHAT_VIEWPORT_SELECTOR = ".lvis-chat-scroll [data-radix-scroll-area-viewport]";

type StreamEvent = Record<string, unknown>;

function longLine(prefix: string, index: number): string {
  return `${prefix}-${index} ${"stable bottom follow without smooth animation overlap ".repeat(8)}\n`;
}

function longChunks(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => longLine(prefix, index));
}

async function launchChatScrollProbe(): Promise<SeededElectronContext> {
  const ctx = await launchSeededElectron({
    settings: buildLlmSettings("openai", "gpt-5.4-mini"),
    sessionTitle: "chat stream scroll jitter",
    historyRows: [
      {
        index: 0,
        role: "user",
        content: "Start a long streamed response with tools.",
        createdAt: Date.now() - 1000,
      },
    ],
  });
  await ctx.page.setViewportSize({ width: 560, height: 860 });
  await ctx.page.locator('[data-testid="composer"]').first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await ctx.page.waitForFunction(
    () => typeof (window as unknown as { __lvisChatStream?: { _emit?: unknown } })
      .__lvisChatStream?._emit === "function",
    undefined,
    { timeout: 20_000 },
  );
  return ctx;
}

async function installScrollProbe(page: Page): Promise<boolean> {
  return page.evaluate((selector) => {
    const viewport = document.querySelector<HTMLElement>(selector);
    if (!viewport) return false;
    const w = window as unknown as {
      __lvisScrollProbe?: {
        smoothCalls: number;
        totalScrollTo: number;
        gaps: number[];
        scrollTops: number[];
        sample: () => void;
      };
    };
    const originalScrollTo = viewport.scrollTo.bind(viewport);
    w.__lvisScrollProbe = {
      smoothCalls: 0,
      totalScrollTo: 0,
      gaps: [],
      scrollTops: [],
      sample() {
        this.gaps.push(Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight));
        this.scrollTops.push(viewport.scrollTop);
      },
    };
    viewport.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      w.__lvisScrollProbe!.totalScrollTo += 1;
      if (typeof options === "object" && options?.behavior === "smooth") {
        w.__lvisScrollProbe!.smoothCalls += 1;
      }
      if (typeof options === "number") {
        originalScrollTo(options, y);
      } else {
        originalScrollTo(options);
      }
    }) as typeof viewport.scrollTo;
    return true;
  }, CHAT_VIEWPORT_SELECTOR);
}

async function emitAndSample(
  page: Page,
  events: StreamEvent[],
  opts: { waitForBottom?: boolean } = {},
): Promise<boolean> {
  return page.evaluate(
    async ({ selector, events, waitForBottom }) => {
      const w = window as unknown as {
        __lvisChatStream?: { _emit?: (event: unknown) => void };
        __lvisScrollProbe?: { sample: () => void };
      };
      const viewport = document.querySelector<HTMLElement>(selector);
      const emit = w.__lvisChatStream?._emit;
      if (!viewport || typeof emit !== "function") return false;
      const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bottomGap = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      for (const event of events) {
        emit(event);
        if (waitForBottom) {
          // The viewport is expected to re-pin to the bottom after the chunk.
          // Wait (capped) until it actually reaches the bottom before sampling,
          // instead of a fixed 2-frame wait — CI rendering can take several
          // frames to re-pin, so a fixed wait samples a mid-layout transient and
          // reports a bogus multi-hundred-px gap (flaky). If pinning genuinely
          // regresses, the gap never closes and the final sample still fails.
          for (let frame = 0; frame < 30; frame++) {
            await nextFrame();
            if (bottomGap() <= 2) break;
          }
        } else {
          await nextFrame();
          await nextFrame();
        }
        w.__lvisScrollProbe?.sample();
      }
      return true;
    },
    { selector: CHAT_VIEWPORT_SELECTOR, events, waitForBottom: opts.waitForBottom === true },
  );
}

async function readProbe(page: Page): Promise<{ smoothCalls: number; totalScrollTo: number; gaps: number[] }> {
  return page.evaluate(() => {
    const probe = (window as unknown as {
      __lvisScrollProbe?: { smoothCalls: number; totalScrollTo: number; gaps: number[] };
    }).__lvisScrollProbe;
    return {
      smoothCalls: probe?.smoothCalls ?? -1,
      totalScrollTo: probe?.totalScrollTo ?? -1,
      gaps: probe?.gaps ?? [],
    };
  });
}

async function readViewport(page: Page): Promise<{ scrollTop: number; bottomGap: number }> {
  return page.evaluate((selector) => {
    const viewport = document.querySelector<HTMLElement>(selector);
    if (!viewport) return { scrollTop: -1, bottomGap: -1 };
    return {
      scrollTop: viewport.scrollTop,
      bottomGap: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
    };
  }, CHAT_VIEWPORT_SELECTOR);
}

test.describe("chat stream bottom-follow jitter", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("long tool_use to end_turn stream remains bottom-pinned without smooth auto-scroll", async () => {
    const ctx = await launchChatScrollProbe();
    try {
      expect(await installScrollProbe(ctx.page)).toBe(true);
      const groupId = `scroll-jitter-${Date.now()}`;
      const toolUseId = `tool-${Date.now()}`;
      const events: StreamEvent[] = [
        { type: "reasoning_delta", text: longChunks("reasoning", 8).join("") },
        { type: "tool_start", name: "web_fetch", groupId, toolUseId, displayOrder: 0, input: { query: "layout" } },
        { type: "tool_end", name: "web_fetch", groupId, toolUseId, result: longChunks("tool-result", 12).join(""), isError: false, durationMs: 900 },
        { type: "text_delta", text: "Intermediate assistant work before tool_use.\n" },
        { type: "assistant_round", stopReason: "tool_use", hasToolCalls: true },
        ...longChunks("final-stream-line", 24).map((text) => ({ type: "text_delta", text })),
        { type: "assistant_round", stopReason: "end_turn" },
        {
          type: "turn_summary",
          tokensIn: 6400,
          freshInputTokens: 1200,
          tokensOut: 900,
          toolCount: 1,
          cumulativeToolMs: 900,
          turnDurationMs: 2400,
          vendorProvider: "openai",
          vendorModel: "gpt-5.4-mini",
        },
      ];

      expect(await emitAndSample(ctx.page, events, { waitForBottom: true })).toBe(true);
      await expect(ctx.page.getByText("final-stream-line-23").first()).toBeVisible();
      await ctx.page.waitForFunction((selector) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) return false;
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
      }, CHAT_VIEWPORT_SELECTOR);

      const probe = await readProbe(ctx.page);
      expect(probe.smoothCalls).toBe(0);
      expect(probe.totalScrollTo).toBe(0);
      expect(Math.max(...probe.gaps)).toBeLessThanOrEqual(2);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("stream growth does not force-scroll after the user leaves the bottom", async () => {
    const ctx = await launchChatScrollProbe();
    try {
      expect(await installScrollProbe(ctx.page)).toBe(true);
      expect(await emitAndSample(
        ctx.page,
        longChunks("pre-scroll-stream-line", 28).map((text) => ({ type: "text_delta", text })),
      )).toBe(true);
      await ctx.page.waitForFunction((selector) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) return false;
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
      }, CHAT_VIEWPORT_SELECTOR);

      const before = await ctx.page.evaluate((selector) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) return { scrollTop: -1, bottomGap: -1 };
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 260);
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        return {
          scrollTop: viewport.scrollTop,
          bottomGap: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
        };
      }, CHAT_VIEWPORT_SELECTOR);
      expect(before.bottomGap).toBeGreaterThan(120);
      await expect(ctx.page.getByTestId("jump-to-bottom")).toBeVisible();

      expect(await emitAndSample(
        ctx.page,
        longChunks("post-user-scroll-line", 6).map((text) => ({ type: "text_delta", text })),
      )).toBe(true);

      const after = await readViewport(ctx.page);
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
      expect(after.bottomGap).toBeGreaterThan(120);
      await expect(ctx.page.getByTestId("jump-to-bottom")).toBeVisible();

      const probeBeforeJump = await readProbe(ctx.page);
      await ctx.page.getByTestId("jump-to-bottom").click();
      await expect
        .poll(async () => (await readProbe(ctx.page)).smoothCalls, { timeout: 5000 })
        .toBeGreaterThan(probeBeforeJump.smoothCalls);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("restores the chat scroll position after leaving home and returning", async () => {
    const ctx = await launchChatScrollProbe();
    try {
      expect(await emitAndSample(
        ctx.page,
        longChunks("restore-position-line", 44).map((text) => ({ type: "text_delta", text })),
        { waitForBottom: true },
      )).toBe(true);
      await ctx.page.waitForFunction((selector) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) return false;
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
      }, CHAT_VIEWPORT_SELECTOR);

      const before = await ctx.page.evaluate((selector) => {
        const viewport = document.querySelector<HTMLElement>(selector);
        if (!viewport) return { scrollTop: -1, bottomGap: -1 };
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 260);
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        return {
          scrollTop: viewport.scrollTop,
          bottomGap: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
        };
      }, CHAT_VIEWPORT_SELECTOR);
      expect(before.bottomGap).toBeGreaterThan(120);
      await expect(ctx.page.getByTestId("jump-to-bottom")).toBeVisible();

      await ctx.page.getByTestId("sidebar-memory").click();
      await expect(ctx.page.getByTestId("main-content-back")).toBeVisible({ timeout: 10_000 });
      await ctx.page.getByTestId("main-content-back").click();
      await expect(ctx.page.locator(CHAT_VIEWPORT_SELECTOR)).toBeVisible({ timeout: 10_000 });

      await expect.poll(async () => (await readViewport(ctx.page)).bottomGap, { timeout: 5_000 })
        .toBeGreaterThan(120);
      const restored = await readViewport(ctx.page);
      expect(Math.abs(restored.bottomGap - before.bottomGap)).toBeLessThanOrEqual(8);
      await expect(ctx.page.getByTestId("jump-to-bottom")).toBeVisible();
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
