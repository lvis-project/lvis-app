import { test, expect } from './fixtures';

/**
 * E2E smoke for the FileEditDiff card rendered by ToolGroupCard for
 * edit_file / apply_patch / write_file tool results.
 *
 * Strategy mirrors tool-duration.spec.ts — inject synthetic tool_start
 * + tool_end events into the renderer's chat-stream channel via
 * `window.__lvisChatStream._emit`, then assert the DOM that the
 * production reducer produces. This exercises the same wiring path
 * (StreamEvent → use-chat-state → applyToolEnd → ToolGroupCard →
 * FileEditDiff) without requiring a live LLM provider.
 *
 * Skips gracefully when the chat input or synthetic emit hook isn't
 * available — matches the offline-CI policy used by sibling specs.
 */

type StreamFn = (event: unknown) => void;
type ChatStreamApi = { _emit?: StreamFn } | undefined;

async function waitForChatReady(mainWindow: import('@playwright/test').Page): Promise<boolean> {
  // Wait for the synthetic stream seam to appear on window. useChatState's
  // useEffect runs as soon as App.tsx mounts (top-level), independent of any
  // downstream conditional like the API-key gate, so this is the most stable
  // ready signal for tests that drive the stream channel directly.
  try {
    await mainWindow.waitForFunction(
      () => typeof (window as unknown as { __lvisChatStream?: { _emit?: unknown } })
        .__lvisChatStream?._emit === 'function',
      undefined,
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function emitToolCycle(
  mainWindow: import('@playwright/test').Page,
  start: Record<string, unknown>,
  end: Record<string, unknown>,
): Promise<boolean> {
  return mainWindow.evaluate(
    ({ start, end }) => {
      const w = window as unknown as { __lvisChatStream?: ChatStreamApi };
      const emit = w.__lvisChatStream?._emit;
      if (typeof emit !== 'function') return false;
      emit({ type: 'tool_start', ...start });
      emit({ type: 'tool_end', ...end });
      return true;
    },
    { start, end },
  );
}

test.describe('FileEditDiff e2e', () => {
  test('edit_file: renders Edit verb + path + diff hunks', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-edit-${Date.now()}`;
    const toolUseId = `tu-edit-${Date.now()}`;
    const path = 'src/sample.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: {
          path,
          oldText: 'const greet = "hello";',
          newText: 'const greet = "annyeong";',
        },
      },
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        result: JSON.stringify({ path, replacements: 1 }),
        isError: false,
        durationMs: 50,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-tool="edit_file"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText(path);
    await expect(card).toContainText('Edit');
    await expect(card).toContainText('hello');
    await expect(card).toContainText('annyeong');
  });

  test('write_file (new file): renders Create verb without before content', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-create-${Date.now()}`;
    const toolUseId = `tu-create-${Date.now()}`;
    const path = 'src/new-module.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'write_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, content: 'export const ANSWER = 42;\n' },
      },
      {
        name: 'write_file',
        groupId,
        toolUseId,
        result: JSON.stringify({
          kind: 'lvis.write_file',
          path,
          bytes: 26,
          isNewFile: true,
          truncated: false,
          after: 'export const ANSWER = 42;\n',
        }),
        isError: false,
        durationMs: 12,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-new-file="true"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText(path);
    await expect(card).toContainText('Create');
    await expect(card).toContainText('ANSWER = 42');
  });

  // Regression guard for the API-key card layering. The card is rendered
  // as an `absolute` overlay (ChatView.tsx:947) sized `w-[400px]` and is
  // expected NOT to occlude the chat history area where ToolGroupCard +
  // FileEditDiff live. If a future change repositions or full-screens that
  // card, this test should fail before users see broken interactions.
  test('FileEditDiff is interactive even when API-key overlay is visible', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'Synthetic stream dispatch unavailable.');

    const groupId = `e2e-overlay-${Date.now()}`;
    const toolUseId = `tu-overlay-${Date.now()}`;
    const path = 'src/overlap.ts';
    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, oldText: 'lo', newText: 'hi' },
      },
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        result: JSON.stringify({ path, replacements: 1 }),
        isError: false,
        durationMs: 5,
      },
    );
    test.skip(!dispatched, 'Dispatch unavailable.');

    const card = mainWindow.locator('[data-testid="file-edit-diff"]').first();
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Verify hit-testing — the card's button is the actual click target,
    // and Playwright's `click` would throw on intercept by the API-key
    // overlay. Trial mode runs the full action chain without committing
    // the click, which is sufficient to assert no overlay obstruction.
    await card.locator('button').first().click({ trial: true });
  });

  test('write_file (truncated): surfaces truncated marker', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-trunc-${Date.now()}`;
    const toolUseId = `tu-trunc-${Date.now()}`;
    const path = 'src/big.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'write_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, content: 'x'.repeat(8000) },
      },
      {
        name: 'write_file',
        groupId,
        toolUseId,
        result: JSON.stringify({
          kind: 'lvis.write_file',
          path,
          bytes: 8000,
          isNewFile: false,
          truncated: true,
          after: 'x'.repeat(100),
        }),
        isError: false,
        durationMs: 18,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-truncated="true"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText('truncated');
  });
});
