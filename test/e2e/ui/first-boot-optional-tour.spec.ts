import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";

test.use({ onboardingCompleted: false, seedApiKey: false });

test("a fresh keyless workspace remains usable while its optional tour can be dismissed", async ({ mainWindow, userDataDir }) => {
  await expect(mainWindow.getByTestId("main-toolbar")).toBeVisible();
  await expect(mainWindow.getByTestId("spotlight-tour:card")).toBeVisible();

  await mainWindow.getByTestId("spotlight-tour:skip").click();
  await expect(mainWindow.getByTestId("spotlight-tour:card")).toHaveCount(0);

  const settingsPath = path.join(userDataDir, "lvis-settings.json");
  await expect.poll(() => {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      features?: { onboardingCompleted?: boolean };
    };
    return settings.features?.onboardingCompleted;
  }).toBe(true);
});
