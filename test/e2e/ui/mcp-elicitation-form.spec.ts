import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

type CapturedDecision = {
  choice?: string;
  elicitationContent?: Record<string, unknown>;
};

test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");
test.use({ seedRepositoryPlugins: false });

test("MCP elicitation approval form returns structured content", async ({ app, mainWindow }) => {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { __approvalResponses: unknown[] };
    state.__approvalResponses = [];
    ipcMain.removeHandler("lvis:approval:respond");
    ipcMain.handle("lvis:approval:respond", (_event, decision: unknown) => {
      state.__approvalResponses.push(decision);
      return { ok: true };
    });
  });

  await app.evaluate(({ BrowserWindow }, req) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send("lvis:approval:request", req);
  }, {
    id: "e2e-mcp-elicitation",
    category: "agent-action",
    kind: "agent-action",
    toolName: "mcp:hr-server:elicitation",
    toolCategory: "meta",
    args: {
      message: "Pick a date",
      requestedSchema: {
        type: "object",
        required: ["date", "count"],
        properties: {
          date: { type: "string", title: "Date" },
          count: { type: "integer", title: "Count" },
          includeNotes: { type: "boolean", title: "Include notes" },
        },
      },
    },
    reason: "Pick a date",
    source: "mcp",
    createdAt: Date.now(),
    requireExplicit: true,
    nonce: "nonce",
    hmac: "hmac",
  });

  await expect(mainWindow.getByTestId("mcp-elicitation-form")).toBeVisible();
  await mainWindow.getByTestId("mcp-elicitation-field-date").fill("2026-07-01");
  await mainWindow.getByTestId("mcp-elicitation-field-count").fill("2");
  await mainWindow.getByTestId("mcp-elicitation-field-includeNotes").click();
  await expect(mainWindow.getByTestId("approve-button")).toBeEnabled();
  await mainWindow.getByTestId("approve-button").click();

  await expect.poll(
    () => app.evaluate(() =>
      (globalThis as unknown as { __approvalResponses?: unknown[] }).__approvalResponses?.length ?? 0,
    ),
    { timeout: 5_000 },
  ).toBe(1);
  const decision = await app.evaluate(
    () => (globalThis as unknown as { __approvalResponses: CapturedDecision[] }).__approvalResponses[0],
  );
  expect(decision).toMatchObject({
    choice: "allow-once",
    elicitationContent: {
      date: "2026-07-01",
      count: 2,
      includeNotes: true,
    },
  });
});
