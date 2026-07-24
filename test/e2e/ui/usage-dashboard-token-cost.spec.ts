import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { builtMainExists, launchSeededElectron, teardownSeededElectron,
} from "./seeded-electron";
import { closeSettingsWindow, openSettingsWindow } from "./settings-window";
import { makeTestT } from "./i18n";

// This spec launches its own Electron via launchSeededElectron (default ko
// settings), independent of the fixture's seedLocale, so bind `t` to that locale.
const t = makeTestT("ko");

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeUsageAudit(lvisHome: string): void {
  const day = todayKey();
  const auditDir = path.join(lvisHome, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const rows = [
    {
      timestamp: `${day}T12:00:00.000Z`,
      sessionId: "mixed-provider-session",
      type: "turn",
      route: "openai/gpt-5.4-mini",
      input: "mixed provider historical turn",
      tokenUsage: {
        inputTokens: 53_000,
        outputTokens: 6300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 1000,
      },
      usageByModel: [
        {
          vendorProvider: "claude",
          vendorModel: "claude-sonnet-4-6",
          tokenUsage: {
            inputTokens: 30_000,
            outputTokens: 5000,
            cacheReadTokens: 4000,
            cacheWriteTokens: 1000,
          },
        },
        {
          vendorProvider: "openai",
          vendorModel: "gpt-5.4-mini",
          tokenUsage: {
            inputTokens: 23_000,
            outputTokens: 1300,
            cacheReadTokens: 1000,
          },
        },
      ],
    },
    {
      timestamp: `${day}T12:05:00.000Z`,
      sessionId: "unknown-cost-session",
      type: "turn",
      route: "legacy",
      input: "unknown cost historical turn",
      tokenUsage: {
        inputTokens: 10_000,
        outputTokens: 1000,
        cacheReadTokens: 500,
      },
    },
  ];
  fs.writeFileSync(
    path.join(auditDir, `${day}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
}

test.describe("usage dashboard token cost e2e", () => {
  test.skip(
    !builtMainExists(),
    "dist/src/main/main.js not built; run bun run build first",
  );

  test("historical mixed-provider rows keep their provider pricing and unknown-cost rows stay unknown", async () => {
    const ctx = await launchSeededElectron({
      sessionTitle: "usage dashboard token cost",
      historyRows: [
        {
          index: 0,
          role: "user",
          content: "사용량 대시보드 e2e",
          createdAt: Date.now() - 1000,
        },
      ],
    });

    try {
      writeUsageAudit(ctx.lvisHome);
      const settingsWindow = await openSettingsWindow(
        ctx.app,
        ctx.page,
        "usage",
      );
      try {
        await expect(settingsWindow.getByTestId("usage-dashboard")).toBeVisible(
          {
            timeout: 10_000,
          },
        );
        await expect(
          settingsWindow.getByText(t("usageDashboard.perVendor")),
        ).toBeVisible();

        const vendorTableRows = settingsWindow
          .locator("table")
          .filter({ hasText: t("usageDashboard.colVendor") })
          .first()
          .locator("tbody tr");
        const claudeRow = vendorTableRows.filter({ hasText: "claude" });
        const openaiRow = vendorTableRows.filter({ hasText: "openai" });
        const unknownRow = vendorTableRows.filter({ hasText: "unknown" });

        await expect(claudeRow).toContainText("claude");
        await expect(claudeRow).not.toContainText(
          t("tokenCostBadge.pricingUnknownBadge"),
        );
        await expect(openaiRow).toContainText("openai");
        await expect(openaiRow).not.toContainText(
          t("tokenCostBadge.pricingUnknownBadge"),
        );

        await expect(unknownRow).toContainText("unknown");
        await expect(unknownRow).toContainText(
          t("usageDashboard.unknownCostTurns", { base: "$0", turns: "1" }),
        );
        // unknownCostIncluded is "{base} + 미정 포함"; assert the static suffix
        // (after the dynamic {base}) via the catalog rather than a literal.
        const unknownIncludedSuffix = t("usageDashboard.unknownCostIncluded", {
          base: "",
        })
          .split("+")
          .pop()!
          .trim();
        await expect(
          settingsWindow.getByText(unknownIncludedSuffix).first(),
        ).toBeVisible();

        await expect(
          settingsWindow.getByText("claude-sonnet-4-6"),
        ).toBeVisible();
        await expect(settingsWindow.getByText("gpt-5.4-mini")).toBeVisible();
      } finally {
        await closeSettingsWindow(ctx.app, settingsWindow);
      }
    } finally {
      await teardownSeededElectron(ctx);
    }
  });
});
