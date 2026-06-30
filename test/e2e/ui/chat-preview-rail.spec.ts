import { test, expect, type Page } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

type JsonObject = Record<string, unknown>;

const READ_PATH = "C:\\workspace\\lvis\\src\\notes.md";
const WRITE_PATH = "C:\\workspace\\lvis\\src\\report.md";

function buildPreviewRows(): JsonObject[] {
  const now = Date.now() - 10_000;
  return [
    {
      role: "user",
      content: "Show me the artifacts from this run.",
      createdAt: now,
    },
    {
      role: "assistant",
      content: "",
      thought: "Collecting files, HTML, JSON, and links for preview.",
      toolCalls: [
        {
          id: "preview-read",
          name: "read_file",
          input: { path: READ_PATH },
        },
        {
          id: "preview-write",
          name: "write_file",
          input: {
            path: WRITE_PATH,
            oldText: "export const value = 1;\n",
            newText: "export const value = 2;\n",
          },
        },
        {
          id: "preview-html",
          name: "render_html",
          input: {},
        },
        {
          id: "preview-web",
          name: "web_fetch",
          input: { url: "https://example.com/docs" },
        },
      ],
      createdAt: now + 100,
    },
    {
      role: "tool_result",
      toolUseId: "preview-read",
      toolName: "read_file",
      content: "# Notes\nPreview source file contents.",
      createdAt: now + 200,
    },
    {
      role: "tool_result",
      toolUseId: "preview-write",
      toolName: "write_file",
      content: JSON.stringify({
        kind: "lvis.write_file",
        path: WRITE_PATH,
        before: "export const value = 1;\n",
        after: "export const value = 2;\n",
      }),
      createdAt: now + 300,
    },
    {
      role: "tool_result",
      toolUseId: "preview-html",
      toolName: "render_html",
      content: JSON.stringify({
        kind: "lvis.render_html",
        title: "Artifact dashboard",
        html: "<section><h1>Preview OK</h1><p>Side rail smoke.</p></section>",
        height: 220,
      }),
      createdAt: now + 400,
    },
    {
      role: "tool_result",
      toolUseId: "preview-web",
      toolName: "web_fetch",
      content: JSON.stringify({ status: 200, title: "Example docs", ok: true }),
      createdAt: now + 500,
    },
    {
      role: "assistant",
      content: "Artifacts are ready for review.",
      createdAt: now + 600,
    },
  ];
}

async function readCdpProbe(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await cdp.detach();
  return {
    metrics: Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value])),
    screenshot,
  };
}

test.describe("chat preview rail", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("opens a side-by-side artifact rail and workspace file browser under CDP", async () => {
    const ctx: SeededElectronContext = await launchSeededElectron({
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      sessionTitle: "preview rail e2e",
      historyRows: buildPreviewRows(),
      userDataPrefix: "lvis-preview-rail-user-data-",
      homePrefix: "lvis-preview-rail-home-",
    });
    try {
      await ctx.page.setViewportSize({ width: 1280, height: 860 });
      await ctx.page.waitForFunction(
        () => typeof (window as unknown as { __lvisChatStream?: { _emit?: unknown } })
          .__lvisChatStream?._emit === "function",
        undefined,
        { timeout: 20_000 },
      );

      const openButton = ctx.page.getByTestId("chat-preview-open");
      await expect(openButton).toBeVisible({ timeout: 20_000 });
      await expect(ctx.page.getByTestId("chat-preview-rail")).toHaveCount(0);

      await openButton.click();
      const rail = ctx.page.getByTestId("chat-preview-rail");
      await expect(rail).toBeVisible({ timeout: 10_000 });
      await expect(rail).toContainText("Artifact dashboard");
      await expect(rail).toContainText("report.md");
      await expect(rail).toContainText("example.com/docs");

      const chatBox = await ctx.page.locator(".lvis-chat-scroll").boundingBox();
      const railBox = await rail.boundingBox();
      expect(chatBox).not.toBeNull();
      expect(railBox).not.toBeNull();
      expect(railBox!.width).toBeGreaterThanOrEqual(300);
      expect(railBox!.x).toBeGreaterThan(chatBox!.x + chatBox!.width - 8);

      await ctx.page.getByTestId("chat-preview-files-tab").click();
      await expect(rail).toContainText("notes.md");
      await expect(rail).toContainText("report.md");
      await ctx.page.getByTestId("chat-preview-search").fill("report");
      const filteredFileRows = rail.getByTestId("chat-preview-file-row");
      await expect(filteredFileRows).toHaveCount(1);
      await expect(filteredFileRows.first()).toContainText("report.md");
      await expect(filteredFileRows.first()).not.toContainText("notes.md");

      const { metrics, screenshot } = await readCdpProbe(ctx.page);
      await test.info().attach("chat-preview-rail-cdp-metrics.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(metrics, null, 2)),
      });
      await test.info().attach("chat-preview-rail-cdp.png", {
        contentType: "image/png",
        body: Buffer.from(screenshot.data, "base64"),
      });
      expect(typeof metrics.TaskDuration).toBe("number");
      expect(screenshot.data.length).toBeGreaterThan(20_000);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
