import type { ElectronApplication, Page } from 'playwright';
import { test, expect } from './fixtures';

type AskQuestionItem = {
  question: string;
  choices?: string[];
  allowFreeText: boolean;
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
    allowFreeText: true,
  },
): Promise<boolean> {
  const injected = await injectAskQuestion(app, id, item);
  const overlay = mainWindow.locator('[data-testid="question-overlay"]');
  return overlay
    .waitFor({ state: 'visible', timeout: injected ? 5_000 : 10_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('ask_user_question overlay layout', () => {
  test('choice list stays between question text and free-text input', async ({ app, mainWindow }) => {
    const visible = await ensureQuestionOverlayVisible(app, mainWindow, 'e2e-question-order', {
      question: '기간과 언어를 선택하세요.',
      choices: ['최근 24시간 / 한국어', '최근 7일 / 한국어', '최근 30일 / 영어(글로벌)'],
      allowFreeText: true,
    });
    expect(visible, 'ask_user_question injection must render the overlay').toBe(true);

    const orderOk = await mainWindow.evaluate(() => {
      const questionText = document.querySelector<HTMLElement>('[data-testid="ask-question-text"]');
      const listbox = document.querySelector<HTMLElement>('[data-testid="ask-user-question-card"] [role="listbox"]');
      const input = document.querySelector<HTMLElement>('[data-testid="ask-freetext-input"]');
      if (!questionText || !listbox || !input) return 'missing-elements';

      const questionBeforeList =
        (questionText.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const listBeforeInput =
        (listbox.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

      if (!questionBeforeList) return 'list-before-question';
      if (!listBeforeInput) return 'input-before-list';
      return 'ok';
    });

    expect(orderOk).toBe('ok');
  });

  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`overlay fills the chat width and sits flush above the status bar at ${viewport.width}x${viewport.height}`, async ({
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
        const main = document.querySelector<HTMLElement>('main');
        const overlay = document.querySelector<HTMLElement>('[data-testid="question-overlay"]');
        const card = document.querySelector<HTMLElement>('[data-testid="ask-user-question-card"]');
        const statusBar = document.querySelector<HTMLElement>('[data-testid="status-bar"]');
        if (!main || !overlay || !card || !statusBar) return null;
        const m = main.getBoundingClientRect();
        const o = overlay.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const s = statusBar.getBoundingClientRect();
        return {
          mainLeft: m.left,
          mainRight: m.right,
          overlayLeft: o.left,
          overlayRight: o.right,
          cardLeft: c.left,
          cardRight: c.right,
          cardBottom: c.bottom,
          statusTop: s.top,
        };
      });

      expect(geometry, 'layout elements must exist').not.toBeNull();
      expect(Math.abs(geometry!.overlayLeft - geometry!.mainLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.overlayRight - geometry!.mainRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardLeft - geometry!.mainLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardRight - geometry!.mainRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.cardBottom - geometry!.statusTop)).toBeLessThanOrEqual(1);
    });
  }

  test('uses choices instead of legacy suggestedAnswers when both are present', async ({ app, mainWindow }) => {
    const visible = await ensureQuestionOverlayVisible(app, mainWindow, 'e2e-question-choice-priority', {
      question: '기간과 언어를 선택하세요.',
      choices: ['최근 24시간 / 한국어', '최근 7일 / 한국어'],
      allowFreeText: false,
      suggestedAnswers: ['레거시 추천 1', '레거시 추천 2'],
    });
    expect(visible, 'ask_user_question injection must render the overlay').toBe(true);

    await expect(mainWindow.getByRole('option', { name: '최근 24시간 / 한국어' })).toBeVisible();
    await expect(mainWindow.getByText('레거시 추천 1')).toBeHidden();
    await expect(mainWindow.locator('[data-testid="fqp-chips-row"]')).toBeHidden();
  });
});
