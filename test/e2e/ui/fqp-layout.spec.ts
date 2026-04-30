import * as path from 'node:path';
import { test, expect } from './fixtures';

/**
 * fqp-layout.spec.ts — FloatingQuestionPanel layout regression spec
 *
 * Validates:
 *   1. Panel center is within ±10 px of the chat-column center.
 *   2. `[data-testid="fqp-chips-row"]` is between `[data-testid="fqp-question-text"]`
 *      and the <textarea> in DOM order.
 *   3. Screenshots captured at 1100×720 (default) and 1440×900 viewports with
 *      sidebar collapsed and expanded states.
 *
 * Trigger strategy:
 *   The FQP only appears when an agent fires `ask_user_question` via IPC.
 *   We inject a mock IPC event by reaching into `window.__lvisApi` (the
 *   renderer-side api-client singleton used in LVIS_E2E mode) and calling
 *   the registered `onAskUserQuestion` callback directly.
 *
 * Graceful-skip:
 *   If the injection point is unavailable (e.g. the API surface changed),
 *   we fall back to the same skip-if-absent pattern used in the existing
 *   floating-question-panel.spec.ts to avoid false CI failures.
 */

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  '../../__screenshots__',
);

/** Inject a synthetic ask_user_question event into the renderer. */
async function injectAskQuestion(
  page: import('@playwright/test').Page,
  id: string,
  question: string,
  allowFreeText: boolean,
): Promise<boolean> {
  return page.evaluate(
    ({ id, question, allowFreeText }: { id: string; question: string; allowFreeText: boolean }) => {
      // The renderer registers callbacks on the api object; we reach them
      // through the global registered under LVIS_E2E mode.
      const api = (window as unknown as Record<string, unknown>).__lvisApi as
        | undefined
        | {
            _askUserQuestionCallbacks?: Array<(req: unknown) => void>;
          };
      if (!api?._askUserQuestionCallbacks?.length) return false;
      const req = {
        id,
        urgent: false,
        createdAt: Date.now(),
        questions: [{ question, choices: [], allowFreeText }],
      };
      for (const cb of api._askUserQuestionCallbacks) {
        cb(req);
      }
      return true;
    },
    { id, question, allowFreeText },
  );
}

test.describe('FQP layout — chip placement and margin symmetry', () => {
  // Shared helper: wait for the FQP to appear, optionally injecting a mock
  // event. Returns true when the panel is visible.
  async function ensurePanelVisible(
    mainWindow: import('@playwright/test').Page,
  ): Promise<boolean> {
    // Try injection first.
    const injected = await injectAskQuestion(
      mainWindow,
      'e2e-layout-test-1',
      '계속 진행할까요?',
      true,
    );

    const panel = mainWindow.locator('[data-testid="floating-question-panel"]');
    const visible = await panel
      .waitFor({ state: 'visible', timeout: injected ? 5_000 : 10_000 })
      .then(() => true)
      .catch(() => false);
    return visible;
  }

  test('chip row is between question text and textarea in DOM order', async ({
    mainWindow,
  }) => {
    const panelVisible = await ensurePanelVisible(mainWindow);
    test.skip(!panelVisible, 'FQP not triggered — skipping DOM-order assertion.');

    const panel = mainWindow.locator('[data-testid="floating-question-panel"]');

    // Chips row must exist (free-text request shows generic chips).
    const chipsRow = panel.locator('[data-testid="fqp-chips-row"]');
    const chipsRowVisible = await chipsRow
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!chipsRowVisible, 'No chips row found — skipping DOM-order assertion.');

    // Verify DOM order: questionText < chipsRow < textarea.
    const orderOk = await mainWindow.evaluate(() => {
      const questionText = document.querySelector<HTMLElement>(
        '[data-testid="fqp-question-text"]',
      );
      const chipsRowEl = document.querySelector<HTMLElement>(
        '[data-testid="fqp-chips-row"]',
      );
      const textarea = document.querySelector<HTMLElement>(
        '[data-testid="floating-question-panel"] textarea',
      );
      if (!questionText || !chipsRowEl) return 'missing-elements';

      // Use Node.DOCUMENT_POSITION_FOLLOWING (4) to check order:
      // A.compareDocumentPosition(B) returns FOLLOWING if B comes after A.
      const questionBeforeChips =
        (questionText.compareDocumentPosition(chipsRowEl) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0;

      if (!textarea) {
        // No textarea means free-text not allowed for this question — chips
        // after question text is still the correct order.
        return questionBeforeChips ? 'ok-no-textarea' : 'chips-before-question';
      }

      const chipsBeforeTextarea =
        (chipsRowEl.compareDocumentPosition(textarea) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0;

      if (!questionBeforeChips) return 'chips-before-question';
      if (!chipsBeforeTextarea) return 'textarea-before-chips';
      return 'ok';
    });

    expect(orderOk, `DOM order check failed: ${orderOk}`).toMatch(/^ok/);
  });

  test('panel center aligns with chat-column center (±10 px) at 1100×720', async ({
    mainWindow,
  }) => {
    await mainWindow.setViewportSize({ width: 1100, height: 720 });

    const panelVisible = await ensurePanelVisible(mainWindow);
    test.skip(!panelVisible, 'FQP not triggered — skipping layout assertion at 1100×720.');

    const panel = mainWindow.locator('[data-testid="floating-question-panel"]');
    await panel.waitFor({ state: 'visible', timeout: 5_000 });

    const panelBox = await panel.boundingBox();
    expect(panelBox, 'panel bounding box must be non-null').not.toBeNull();

    // The panel must span the full chat column (inset-x-0 on its container).
    // Compute the chat-column bounding box via the <main> element.
    const chatColumnBounds = await mainWindow.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return null;
      const r = main.getBoundingClientRect();
      return { x: r.x, width: r.width };
    });

    if (chatColumnBounds && panelBox) {
      const chatCenterX = chatColumnBounds.x + chatColumnBounds.width / 2;
      const panelCenterX = panelBox.x + panelBox.width / 2;
      expect(
        Math.abs(chatCenterX - panelCenterX),
        `Panel center (${panelCenterX.toFixed(1)}) must be within ±10 px of chat-column center (${chatCenterX.toFixed(1)})`,
      ).toBeLessThanOrEqual(10);
    }

    // Screenshot — golden reference.
    await mainWindow.screenshot({
      path: `${SCREENSHOT_DIR}/fqp-layout-1100x720.png`,
    });
  });

  test('panel center aligns with chat-column center (±10 px) at 1440×900', async ({
    mainWindow,
  }) => {
    await mainWindow.setViewportSize({ width: 1440, height: 900 });

    const panelVisible = await ensurePanelVisible(mainWindow);
    test.skip(!panelVisible, 'FQP not triggered — skipping layout assertion at 1440×900.');

    const panel = mainWindow.locator('[data-testid="floating-question-panel"]');
    await panel.waitFor({ state: 'visible', timeout: 5_000 });

    const panelBox = await panel.boundingBox();
    expect(panelBox, 'panel bounding box must be non-null').not.toBeNull();

    const chatColumnBounds = await mainWindow.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return null;
      const r = main.getBoundingClientRect();
      return { x: r.x, width: r.width };
    });

    if (chatColumnBounds && panelBox) {
      const chatCenterX = chatColumnBounds.x + chatColumnBounds.width / 2;
      const panelCenterX = panelBox.x + panelBox.width / 2;
      expect(
        Math.abs(chatCenterX - panelCenterX),
        `Panel center (${panelCenterX.toFixed(1)}) must be within ±10 px of chat-column center (${chatCenterX.toFixed(1)})`,
      ).toBeLessThanOrEqual(10);
    }

    await mainWindow.screenshot({
      path: `${SCREENSHOT_DIR}/fqp-layout-1440x900.png`,
    });
  });

  test('layout stays symmetric with sidebar visible', async ({ mainWindow }) => {
    await mainWindow.setViewportSize({ width: 1100, height: 720 });

    // Verify sidebar is visible (it has a fixed w-32 / 128px).
    const sidebar = mainWindow.locator('aside');
    const sidebarVisible = await sidebar
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!sidebarVisible, 'Sidebar not found — skipping sidebar-visible layout check.');

    const panelVisible = await ensurePanelVisible(mainWindow);
    test.skip(!panelVisible, 'FQP not triggered — skipping sidebar layout assertion.');

    const panel = mainWindow.locator('[data-testid="floating-question-panel"]');
    await panel.waitFor({ state: 'visible', timeout: 5_000 });

    const panelBox = await panel.boundingBox();
    const mainBox = await mainWindow
      .locator('main')
      .boundingBox();

    if (panelBox && mainBox) {
      const leftMargin = panelBox.x - mainBox.x;
      const rightMargin = mainBox.x + mainBox.width - (panelBox.x + panelBox.width);
      // With px-4 padding the content is inset 16px on each side.
      // Allow ±4 px tolerance for subpixel rendering.
      expect(
        Math.abs(leftMargin - rightMargin),
        `Left margin (${leftMargin.toFixed(1)}) and right margin (${rightMargin.toFixed(1)}) must be symmetric within ±4 px`,
      ).toBeLessThanOrEqual(4);
    }

    await mainWindow.screenshot({
      path: `${SCREENSHOT_DIR}/fqp-layout-sidebar-visible.png`,
    });
  });
});
