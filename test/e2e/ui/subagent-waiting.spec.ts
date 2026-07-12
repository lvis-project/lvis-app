import { test, expect } from "./fixtures";
import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";


test("budget-suspended sub-agent renders waiting in the workspace rail", async ({
  app,
  mainWindow,
  t,
}) => {
  await expect(mainWindow.getByTestId("chat-view-root")).toBeVisible();

  const events = [
    {
      spawnId: "spawn-budget-waiting",
      type: "start",
      taskState: "TASK_STATE_SUBMITTED",
      title: "Budget suspended agent",
      instructions: "Continue until the assigned round budget.",
    },
    {
      spawnId: "spawn-budget-waiting",
      type: "done",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      status: "waiting",
      title: "Budget suspended agent",
      summary: "Partial work is ready to resume.",
      toolCallCount: 2,
      childSessionId: "child-budget-waiting",
      suspension: {
        reason: "budget",
        resumeId: "child-budget-waiting",
      },
    },
  ] satisfies AgentSpawnEvent[];
  await app.evaluate(({ BrowserWindow }, injectedEvents) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error("agent-spawn-e2e-window-missing");
    for (const event of injectedEvents) {
      win.webContents.send("lvis:agent-spawn:event", event);
    }
  }, events);

  const row = mainWindow.getByTestId("chat-side-panel-subagent-row");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("Budget suspended agent");
  await expect(row).toContainText(t("subAgentCard.statusWaiting"));
  await expect(row).not.toContainText(t("subAgentCard.statusDone"));
  await expect(row.getByText(t("subAgentCard.statusWaiting"))).toHaveClass(/text-warning/);

  await test.info().attach("subagent-budget-waiting-rail.png", {
    body: await mainWindow.screenshot(),
    contentType: "image/png",
  });
});
