import { test, expect } from "@playwright/test";
import {
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

test("session files show only the created transfer destinations", async () => {
  expect(builtMainExists(), "Build the app before checking the transfer UI").toBe(true);
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "structured transfer preview",
    historyRows: [
      { role: "user", content: "Copy the assets and extract the archive.", createdAt: now },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "copy", name: "copy_path", source: "builtin", category: "write", input: { sourcePath: "original-assets", destinationPath: "copied-assets" } },
          { id: "extract", name: "extract_archive", source: "builtin", category: "write", input: { archivePath: "original-assets.tar", destinationPath: "unpacked-assets" } },
        ],
        createdAt: now + 100,
      },
      {
        role: "tool_result", toolUseId: "copy", toolName: "copy_path",
        content: JSON.stringify({ ok: true, summary: { sourcePath: "original-assets", destinationPath: "copied-assets", files: 0, directories: 1, bytesWritten: 0 } }),
        createdAt: now + 200,
      },
      {
        role: "tool_result", toolUseId: "extract", toolName: "extract_archive",
        content: JSON.stringify({ ok: true, summary: { sourcePath: "original-assets.tar", destinationPath: "unpacked-assets", files: 0, directories: 1, bytesWritten: 0, archiveFormat: "tar" } }),
        createdAt: now + 300,
      },
      { role: "assistant", content: "Both transfers completed.", createdAt: now + 400 },
    ],
  });
  try {
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    const toggle = ctx.page.getByTestId(TEST_IDS.panePanelToggle);
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    await ctx.page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await ctx.page.getByTestId("chat-side-panel-file-source-session").click();
    const files = ctx.page.getByTestId("chat-side-panel-file-tree");
    await expect(files).toBeVisible();
    await expect(files).toContainText("copied-assets");
    await expect(files).toContainText("unpacked-assets");
    await expect(files).not.toContainText("original-assets");
    await test.info().attach("structured-transfer-destinations.png", {
      contentType: "image/png",
      body: await ctx.page.screenshot(),
    });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
