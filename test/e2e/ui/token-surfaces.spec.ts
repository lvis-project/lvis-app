import { test, expect } from "@playwright/test";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  sendRendererStreamEvent,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";

function turnSummary(opts: {
  tokensIn: number;
  freshInputTokens: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCount?: number;
}) {
  return {
    tokensIn: opts.tokensIn,
    freshInputTokens: opts.freshInputTokens,
    tokensOut: opts.tokensOut,
    ...(opts.cacheReadTokens !== undefined ? { cacheReadTokens: opts.cacheReadTokens } : {}),
    ...(opts.cacheWriteTokens !== undefined ? { cacheWriteTokens: opts.cacheWriteTokens } : {}),
    turnDurationMs: 2400,
    toolCount: opts.toolCount ?? 0,
    cumulativeToolMs: opts.toolCount ? 180 : 0,
    vendorProvider: "openai",
    vendorModel: "gpt-5.4-mini",
    usageByModel: [
      {
        vendorProvider: "openai",
        vendorModel: "gpt-5.4-mini",
        tokenUsage: {
          inputTokens: opts.freshInputTokens + (opts.cacheReadTokens ?? 0) + (opts.cacheWriteTokens ?? 0),
          outputTokens: opts.tokensOut,
          ...(opts.cacheReadTokens !== undefined ? { cacheReadTokens: opts.cacheReadTokens } : {}),
          ...(opts.cacheWriteTokens !== undefined ? { cacheWriteTokens: opts.cacheWriteTokens } : {}),
        },
      },
    ],
  };
}

async function expectChatBooted(ctx: SeededElectronContext): Promise<void> {
  await ctx.page.locator('[data-testid="composer"]').first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
}

test.describe("context-budget token surfaces", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("seeded JSONL turn_summary drives TokenProgressRing and TokenCostBadge", async () => {
    const now = Date.now();
    const ctx = await launchSeededElectron({
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      sessionTitle: "token surface replay",
      historyRows: [
        { index: 0, role: "user", content: "토큰 표면 테스트", createdAt: now - 10_000 },
        {
          index: 1,
          role: "assistant",
          content: "토큰 표면 응답",
          createdAt: now - 9000,
          turnSummary: turnSummary({
            tokensIn: 123_456,
            freshInputTokens: 1200,
            tokensOut: 800,
            cacheReadTokens: 400,
            cacheWriteTokens: 50,
            toolCount: 1,
          }),
        },
      ],
    });

    try {
      await expectChatBooted(ctx);
      await expect(ctx.page.getByText("토큰 표면 응답")).toBeVisible();

      const ring = ctx.page.getByTestId("token-progress-ring");
      // gpt-5.4-mini is TPM-bound (tpmDefault 200_000 in pricing-data), so the
      // effective limit is 200K: 123,456 / 200,000 ≈ 62%.
      await expect(ring).toHaveAttribute("aria-label", "Projected input 62 percent");
      await ring.hover({ force: true });
      await expect(ctx.page.getByText("projected input").first()).toBeVisible();
      await expect(ctx.page.getByText("123,456").first()).toBeVisible();
      await expect(ctx.page.getByText("effective limit (TPM):").first()).toBeVisible();

      const badge = ctx.page.getByTestId("token-cost-badge").first();
      await expect(badge).toContainText("2.0k");
      await expect(badge).not.toContainText("미정");
      await badge.click({ force: true });
      await expect(badge).toContainText("≈");
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("compact replay suppresses stale pre-compact summaries and keeps post-compact tokens visible", async () => {
    const now = Date.now();
    const ctx = await launchSeededElectron({
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      sessionTitle: "compact token replay",
      historyRows: [
        {
          index: 0,
          role: "user",
          content: "",
          createdAt: now - 8000,
          checkpointMeta: {
            removedMessages: 6,
            freedTokens: 258_000,
            compactNum: 3,
            trigger: "auto-compact",
            compactStatus: "summarized",
            summary: "압축된 이전 대화",
            contextTokensAfter: 42_000,
          },
        },
        { index: 1, role: "user", content: "압축 이전 질문", createdAt: now - 10_000 },
        {
          index: 2,
          role: "assistant",
          content: "압축 이전 응답",
          createdAt: now - 9500,
          turnSummary: turnSummary({
            tokensIn: 300_000,
            freshInputTokens: 10_000,
            tokensOut: 1000,
          }),
        },
        { index: 3, role: "user", content: "압축 이후 질문", createdAt: now - 4000 },
        {
          index: 4,
          role: "assistant",
          content: "압축 이후 응답",
          createdAt: now - 3000,
          turnSummary: turnSummary({
            tokensIn: 42_000,
            freshInputTokens: 900,
            tokensOut: 300,
          }),
        },
      ],
    });

    try {
      await expectChatBooted(ctx);
      await expect(ctx.page.getByTestId("checkpoint-divider")).toBeVisible();
      await expect(ctx.page.getByText("압축 이후 응답")).toBeVisible();

      await expect(ctx.page.getByTestId("token-progress-ring")).toHaveAttribute(
        "aria-label",
        // post-compact projected 42,000 / 200,000 (TPM) ≈ 21%
        "Projected input 21 percent",
      );
      await expect(ctx.page.getByTestId("token-cost-badge")).toHaveCount(1);
      await ctx.page.getByTestId("token-progress-ring").hover({ force: true });
      await expect(ctx.page.getByText("42,000").first()).toBeVisible();
      await expect(ctx.page.getByText("300,000")).toHaveCount(0);
    } finally {
      await teardownSeededElectron(ctx);
    }
  });

  test("multimodal and large tool-result replay keeps projected input while force-compact warns", async () => {
    const now = Date.now();
    const largeToolResult = "large web_fetch result chunk\n".repeat(600);
    const ctx = await launchSeededElectron({
      settings: buildLlmSettings("openai", "gpt-5.4-mini"),
      sessionTitle: "multimodal large tool replay",
      historyRows: [
        {
          index: 0,
          role: "user",
          content: "[image: whiteboard.png]\n첨부 이미지와 검색 결과를 함께 요약해줘",
          displayText: "첨부 이미지와 검색 결과를 함께 요약해줘",
          createdAt: now - 10_000,
        },
        {
          index: 1,
          role: "assistant",
          content: "",
          createdAt: now - 9000,
          toolCalls: [
            {
              id: "tool-large-search",
              name: "web_fetch",
              input: { url: "https://example.test/large-result" },
            },
          ],
        },
        {
          index: 2,
          role: "tool_result",
          toolUseId: "tool-large-search",
          toolName: "web_fetch",
          content: largeToolResult,
          createdAt: now - 8500,
          toolDisplay: { durationMs: 180 },
        },
        {
          index: 3,
          role: "assistant",
          content: "큰 툴 결과 이후 응답",
          createdAt: now - 7000,
          turnSummary: turnSummary({
            tokensIn: 180_000,
            freshInputTokens: 2400,
            tokensOut: 900,
            cacheReadTokens: 1200,
            toolCount: 1,
          }),
        },
      ],
    });

    try {
      await expectChatBooted(ctx);
      await expect(ctx.page.getByText("큰 툴 결과 이후 응답")).toBeVisible();
      await expect(ctx.page.getByTestId("token-progress-ring")).toHaveAttribute(
        "aria-label",
        // projected 180,000 / 200,000 (TPM) = 90%
        "Projected input 90 percent",
      );
      await ctx.page.getByTestId("token-progress-ring").hover({ force: true });
      await expect(ctx.page.getByText("180,000").first()).toBeVisible();

      const statusBar = ctx.page.locator('[data-testid="status-bar"]');
      await sendRendererStreamEvent(ctx.app, {
        type: "compact_started",
        triggerSource: "force-recover",
        estimatedBefore: 390_000,
        preflight: 388_000,
      });
      await expect
        .poll(async () => (await statusBar.textContent()) ?? "", { timeout: 8000 })
        .toContain("자동 압축을 끄셨지만");
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
