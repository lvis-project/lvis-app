import type { ElectronApplication } from "playwright";
import { expect, test } from "./fixtures.js";

type CapturedResponse = {
  requestId?: string;
  answers?: Array<{ choice?: string; choices?: string[] }>;
  dismissed?: boolean;
};

async function installQuestionHarness(
  app: ElectronApplication,
  requestId: string,
  responseResult: { ok: boolean; error?: string } = { ok: true },
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, payload) => {
      const state = globalThis as unknown as { __askUserQuestionResponses: unknown[] };
      state.__askUserQuestionResponses = [];
      ipcMain.removeHandler("lvis:ask-user-question:respond");
      ipcMain.handle("lvis:ask-user-question:respond", (_event, response: unknown) => {
        state.__askUserQuestionResponses.push(response);
        return payload.responseResult;
      });

      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.webContents.send("lvis:ask-user-question:request", {
        id: payload.requestId,
        createdAt: Date.now(),
        questions: [
          {
            question: "진행 방식을 선택하세요.",
            choices: ["계속 진행", "중단"],
          },
        ],
      });
    },
    { requestId, responseResult },
  );
}

async function capturedResponses(app: ElectronApplication): Promise<CapturedResponse[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __askUserQuestionResponses?: CapturedResponse[] })
        .__askUserQuestionResponses ?? [],
  );
}

async function expectResponseCount(app: ElectronApplication, count: number): Promise<void> {
  await expect.poll(() => capturedResponses(app).then((responses) => responses.length), {
    timeout: 5_000,
  }).toBe(count);
}

test.use({ seedRepositoryPlugins: false });

test.describe("ask_user_question interaction", () => {
  test("submits a declared choice and removes the resolved card", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, "e2e-choice-submit");

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid="ask-freetext-input"]')).toHaveCount(0);
    await card.getByRole("option", { name: "계속 진행" }).click();

    await expectResponseCount(app, 1);
    await expect(card).toHaveCount(0);
    expect(await capturedResponses(app)).toEqual([
      {
        requestId: "e2e-choice-submit",
        answers: [{ choice: "계속 진행" }],
      },
    ]);
  });

  test("dismisses the card without synthesizing a manual answer", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, "e2e-choice-dismiss");

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await card.getByTestId("ask-skip-button").click();

    await expectResponseCount(app, 1);
    await expect(card).toHaveCount(0);
    expect(await capturedResponses(app)).toEqual([
      { requestId: "e2e-choice-dismiss", dismissed: true },
    ]);
  });

  test("keeps the card visible when main rejects the response", async ({ app, mainWindow }) => {
    await installQuestionHarness(app, "e2e-choice-rejected", {
      ok: false,
      error: "invalid-answer",
    });

    const card = mainWindow.getByTestId("ask-user-question-card");
    await expect(card).toBeVisible();
    await card.getByRole("option", { name: "계속 진행" }).click();

    await expectResponseCount(app, 1);
    await expect(card).toBeVisible();
    await expect(card.getByRole("option", { name: "중단" })).toBeEnabled();
  });
});
