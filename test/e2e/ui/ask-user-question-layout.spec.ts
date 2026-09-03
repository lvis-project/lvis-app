import type { ElectronApplication, Page } from 'playwright';
import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

type AskQuestionItem = {
  question: string;
  choices?: string[];
  suggestedAnswers?: string[];
};

async function injectAskQuestion(
  app: ElectronApplication,
  id: string,
  item: AskQuestionItem,
): Promise<boolean> {
  return app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!win) return false;
      win.webContents.send('lvis:ask-user-question:request', {
        id: payload.id,
        createdAt: Date.now(),
        questions: [payload.item],
      });
      return true;
    },
    { id, item },
  );
}

async function ensureQuestionOverlayVisible(
  app: ElectronApplication,
  mainWindow: Page,
  id: string,
  item: AskQuestionItem = {
    question: '계속 진행할까요?',
    choices: ['계속', '중단'],
  },
): Promise<boolean> {
  const injected = await injectAskQuestion(app, id, item);
  const overlay = mainWindow.locator(testIdSelector(TEST_IDS.questionOverlay));
  return overlay
    .waitFor({ state: 'visible', timeout: injected ? 5_000 : 10_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('ask_user_question overlay layout', () => {
  test('choice list follows the question and a choice-only question draws no input', async ({ app, mainWindow }) => {
    const visible = await ensureQuestionOverlayVisible(app, mainWindow, 'e2e-question-order', {
      question: '기간과 언어를 선택하세요.',
      choices: ['최근 24시간 / 한국어', '최근 7일 / 한국어', '최근 30일 / 영어(글로벌)'],
    });
    expect(visible, 'ask_user_question injection must render the overlay').toBe(true);

    const orderOk = await mainWindow.evaluate(() => {
      const questionText = document.querySelector<HTMLElement>('[data-testid="ask-question-text"]');
      const listbox = document.querySelector<HTMLElement>('[data-testid="ask-user-question-card"] [role="listbox"]');
      const input = document.querySelector<HTMLElement>('[data-testid="ask-freetext-input"]');
      if (!questionText || !listbox) return 'missing-elements';
      if (input) return 'manual-input-present';

      const questionBeforeList =
        (questionText.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!questionBeforeList) return 'list-before-question';
      return 'ok';
    });

    expect(orderOk).toBe('ok');
  });

  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`overlay fills the chat width and is flush with its dock at ${viewport.width}x${viewport.height}`, async ({
      app,
      mainWindow,
    }) => {
      await mainWindow.setViewportSize(viewport);

      const visible = await ensureQuestionOverlayVisible(
        app,
        mainWindow,
        `e2e-question-geometry-${viewport.width}`,
      );
      expect(visible, 'ask_user_question injection must render the overlay').toBe(true);

      const geometry = await mainWindow.evaluate(() => {
        const overlay = document.querySelector<HTMLElement>('[data-testid="question-overlay"]');
        const card = document.querySelector<HTMLElement>('[data-testid="ask-user-question-card"]');
        if (!overlay || !card) return null;
        const dock = overlay.parentElement;
        if (!dock) return null;
        const o = overlay.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const d = dock.getBoundingClientRect();
        return {
          dockLeft: d.left,
          dockRight: d.right,
          overlayLeft: o.left,
          overlayRight: o.right,
          cardLeft: c.left,
          cardRight: c.right,
          cardBottom: c.bottom,
          dockBottom: d.bottom,
        };
      });

      expect(geometry, 'layout elements must exist').not.toBeNull();
      expect(Math.abs(geometry!.overlayLeft - geometry!.dockLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.overlayRight - geometry!.dockRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardLeft - geometry!.dockLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardRight - geometry!.dockRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardBottom - geometry!.dockBottom)).toBeLessThanOrEqual(1);
    });
  }

  test('uses choices instead of legacy suggestedAnswers when both are present', async ({ app, mainWindow }) => {
    const visible = await ensureQuestionOverlayVisible(app, mainWindow, 'e2e-question-choice-priority', {
      question: '기간과 언어를 선택하세요.',
      choices: ['최근 24시간 / 한국어', '최근 7일 / 한국어'],
      suggestedAnswers: ['레거시 추천 1', '레거시 추천 2'],
    });
    expect(visible, 'ask_user_question injection must render the overlay').toBe(true);

    await expect(mainWindow.getByRole('option', { name: '최근 24시간 / 한국어' })).toBeVisible();
    await expect(mainWindow.getByText('레거시 추천 1')).toBeHidden();
  });
});
