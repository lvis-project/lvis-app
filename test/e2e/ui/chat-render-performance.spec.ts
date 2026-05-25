import { test, expect, type Page } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

type JsonObject = Record<string, unknown>;

const HISTORICAL_TURNS = 24;
const TOOLS_PER_TURN = 2;
const INPUT_PROBE_TEXT = "latency regression probe";

const AVG_INPUT_FRAME_BUDGET_MS = 120;
const MAX_INPUT_FRAME_BUDGET_MS = 360;
const CDP_TASK_BUDGET_MS = 2_500;
const LONG_TASK_BUDGET_MS = 260;

function payload(seed: string, repeat = 36): string {
  return Array.from(
    { length: repeat },
    (_, index) => `${seed}-${index} historical tool result payload with markdown **bold** and inline_code_token_${index}`,
  ).join("\n");
}

function buildLargeHistoricalRows(): JsonObject[] {
  const rows: JsonObject[] = [];
  const now = Date.now() - 60_000;
  for (let turn = 0; turn < HISTORICAL_TURNS; turn++) {
    const toolCalls = Array.from({ length: TOOLS_PER_TURN }, (_, tool) => ({
      id: `hist-${turn}-${tool}`,
      name: tool === 0 ? "web_fetch" : "index_search",
      input: {
        query: `historical query ${turn}-${tool}`,
        nested: { turn, tool, marker: payload(`input-${turn}-${tool}`, 3) },
      },
    }));
    rows.push({
      role: "user",
      content: `historical user turn ${turn}`,
      createdAt: now + turn * 1_000,
    });
    rows.push({
      role: "assistant",
      content: `working through historical turn ${turn}\n${payload(`assistant-work-${turn}`, 8)}`,
      thought: payload(`thought-${turn}`, 8),
      toolCalls,
      createdAt: now + turn * 1_000 + 100,
    });
    for (const [tool, call] of toolCalls.entries()) {
      rows.push({
        role: "tool_result",
        toolUseId: call.id,
        toolName: call.name,
        content: payload(`tool-result-${turn}-${tool}`, 32),
        createdAt: now + turn * 1_000 + 200 + tool,
      });
    }
    rows.push({
      role: "assistant",
      content: `final answer for historical turn ${turn}\n${payload(`assistant-final-${turn}`, 5)}`,
      createdAt: now + turn * 1_000 + 500,
    });
  }
  rows.push({
    role: "user",
    content: "current active turn starts after large history",
    createdAt: now + HISTORICAL_TURNS * 1_000,
  });
  return rows;
}

async function launchLargeTranscriptProbe(): Promise<SeededElectronContext> {
  const ctx = await launchSeededElectron({
    settings: buildLlmSettings("openai", "gpt-5.4-mini"),
    sessionTitle: "chat render performance regression",
    historyRows: buildLargeHistoricalRows(),
    userDataPrefix: "lvis-render-perf-user-data-",
    homePrefix: "lvis-render-perf-home-",
  });
  await ctx.page.setViewportSize({ width: 640, height: 920 });
  await ctx.page.locator('[data-testid="composer-textarea"]').first().waitFor({
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

async function metricMap(page: Page): Promise<Record<string, number>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value]));
}

async function emitSyntheticStream(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __lvisChatStream?: { _emit?: (event: unknown) => void };
    };
    const emit = w.__lvisChatStream?._emit;
    if (typeof emit !== "function") return false;
    emit({ type: "reasoning_delta", text: "active reasoning before input probe" });
    emit({
      type: "tool_start",
      name: "web_fetch",
      groupId: "active-perf",
      toolUseId: "active-perf-tool",
      displayOrder: 0,
      input: { query: "perf" },
    });
    emit({
      type: "tool_end",
      name: "web_fetch",
      groupId: "active-perf",
      toolUseId: "active-perf-tool",
      result: "active tool result",
      isError: false,
      durationMs: 12,
    });
    emit({ type: "text_delta", text: "active streaming response before input probe" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  });
}

async function runComposerInputProbe(page: Page, text: string) {
  return page.evaluate(async (probeText) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]');
    if (!textarea) throw new Error("composer textarea missing");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("textarea value setter missing");
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const probe = {
      durations: [] as number[],
      longTasks: [] as number[],
    };
    const observer = "PerformanceObserver" in window
      ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
      })
      : null;
    try {
      observer?.observe({ type: "longtask", buffered: true });
    } catch {
      observer?.disconnect();
    }
    textarea.focus();
    valueSetter.call(textarea, "");
    textarea.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
    await nextFrame();
    for (const ch of probeText) {
      const before = performance.now();
      valueSetter.call(textarea, textarea.value + ch);
      textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true }));
      await nextFrame();
      probe.durations.push(performance.now() - before);
    }
    observer?.disconnect();
    return {
      textLength: probeText.length,
      durations: probe.durations,
      longTasks: probe.longTasks,
      value: textarea.value,
    };
  }, text);
}

test.describe("chat render performance", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("composer input stays responsive with large historical WorkGroups during stream updates", async () => {
    test.slow();
    const ctx = await launchLargeTranscriptProbe();
    try {
      await expect(ctx.page.locator('[data-testid="work-group"]').first()).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => ctx.page.locator('[data-testid="work-group"]').count(), { timeout: 20_000 })
        .toBeGreaterThanOrEqual(HISTORICAL_TURNS);

      expect(await emitSyntheticStream(ctx.page)).toBe(true);
      await expect(ctx.page.getByText("active streaming response before input probe").first()).toBeVisible();

      const before = await metricMap(ctx.page);
      const probe = await runComposerInputProbe(ctx.page, INPUT_PROBE_TEXT);
      const after = await metricMap(ctx.page);

      expect(probe.value).toBe(INPUT_PROBE_TEXT);
      const total = probe.durations.reduce((sum, value) => sum + value, 0);
      const avg = total / probe.durations.length;
      const max = Math.max(...probe.durations);
      const cdpTaskMs = ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000;
      const cdpScriptMs = ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000;
      const maxLongTask = Math.max(0, ...probe.longTasks);

      await test.info().attach("render-latency-metrics.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({
          textLength: probe.textLength,
          avgMs: Number(avg.toFixed(1)),
          maxMs: Number(max.toFixed(1)),
          cdpTaskMs: Number(cdpTaskMs.toFixed(1)),
          cdpScriptMs: Number(cdpScriptMs.toFixed(1)),
          longTaskCount: probe.longTasks.length,
          maxLongTaskMs: Number(maxLongTask.toFixed(1)),
        }, null, 2)),
      });

      expect(avg).toBeLessThanOrEqual(AVG_INPUT_FRAME_BUDGET_MS);
      expect(max).toBeLessThanOrEqual(MAX_INPUT_FRAME_BUDGET_MS);
      expect(cdpTaskMs).toBeLessThanOrEqual(CDP_TASK_BUDGET_MS);
      expect(maxLongTask).toBeLessThanOrEqual(LONG_TASK_BUDGET_MS);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
