/**
 * E2E: SessionTodoPanel appears inside ChatView when the assistant emits
 * `lvis:session-todo:changed` with in-progress items.
 *
 * Strategy: simulate the main-process IPC event with the active chat session
 * id and one in_progress item, then assert that
 * [data-testid="session-todo-panel"] is visible within the chat container —
 * NOT as a top-level overlay.
 *
 * We use a light structural assertion (presence of the panel and active row)
 * rather than content text, so the test is resilient to copy changes.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function currentSessionId(mainWindow: Page): Promise<string> {
  return mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      lvisApi?: {
        chatSessions?: (opts?: { kind?: string }) => Promise<{ current?: string }>;
      };
    }).lvisApi;
    if (typeof api?.chatSessions !== 'function') {
      throw new Error('window.lvisApi.chatSessions unavailable');
    }
    const listed = await api.chatSessions({ kind: 'main' });
    if (typeof listed.current !== 'string' || listed.current.length === 0) {
      throw new Error('current chat session id unavailable');
    }
    return listed.current;
  });
}

test('session-todo-panel is NOT present when no todos exist', async ({ mainWindow }) => {
  // The panel renders null when items list is empty — should not be in DOM
  const panel = mainWindow.locator('[data-testid="session-todo-panel"]');
  const visible = await panel.isVisible().catch(() => false);
  expect(visible).toBe(false);
});

test('session-todo-panel appears inside ChatView after session-todo:changed event', async ({ app, mainWindow }) => {
  const sessionId = await currentSessionId(mainWindow);
  // Emit a session-todo:changed event with one in_progress item via the
  // preload bridge that the renderer's api.onSessionTodoChanged subscribes to.
  await app.evaluate(({ BrowserWindow }, sid) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) return false;
    const item = { id: 'e2e-1', content: 'E2E: Write the fix', status: 'in_progress' };
    win.webContents.send('lvis:session-todo:changed', { sessionId: sid, items: [item] });
    return true;
  }, sessionId);

  // Panel should now be visible — it lives inside the chat root grid, not as
  // a top-level overlay.
  const panel = mainWindow.locator('[data-testid="session-todo-panel"]');
  const found = await panel
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  expect(
    found,
    'session-todo-panel must appear inside ChatView after session-todo:changed; ' +
    'check that SessionTodoPanel is mounted in ChatView.tsx and that the IPC bridge fires',
  ).toBe(true);

  await expect(panel).toBeVisible();

  // Collapsed by default: the active item is visible in the header.
  const collapsedActive = mainWindow.locator('[data-testid="session-todo-collapsed-active"]');
  await expect(collapsedActive).toBeVisible();

  // Expanding the panel should reveal the active row.
  await panel.locator('button').click();
  const activeRow = mainWindow.locator('[data-testid="session-todo-active-row"]');
  await expect(activeRow).toBeVisible();

  const geometry = await mainWindow.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main');
    const dock = document.querySelector<HTMLElement>('[data-testid="session-todo-dock"]');
    const panel = document.querySelector<HTMLElement>('[data-testid="session-todo-panel"]');
    if (!main || !dock || !panel) return null;
    const m = main.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      mainLeft: m.left,
      mainRight: m.right,
      dockLeft: d.left,
      dockRight: d.right,
      panelLeft: p.left,
      panelRight: p.right,
    };
  });

  expect(geometry, 'session todo dock geometry must be measurable').not.toBeNull();
  expect(Math.abs(geometry!.dockLeft - geometry!.mainLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.dockRight - geometry!.mainRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.panelLeft - geometry!.mainLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.panelRight - geometry!.mainRight)).toBeLessThanOrEqual(1);
});

test('session-todo-panel clears and labels fresh/add/update mutations', async ({ app, mainWindow }) => {
  const sessionId = await currentSessionId(mainWindow);
  const emitTodos = async (items: Array<{ id: string; content: string; status: string }>) => {
    await app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!win) return false;
      win.webContents.send('lvis:session-todo:changed', payload);
      return true;
    }, { sessionId, items });
  };

  await emitTodos([{ id: 'fresh-1', content: 'fresh step', status: 'pending' }]);
  const panel = mainWindow.locator('[data-testid="session-todo-panel"]');
  await expect(panel).toBeVisible();
  await expect(mainWindow.locator('[data-testid="session-todo-fresh"]')).toBeVisible();

  await emitTodos([
    { id: 'fresh-1', content: 'fresh step', status: 'pending' },
    { id: 'fresh-2', content: 'added step', status: 'pending' },
  ]);
  await expect(mainWindow.locator('[data-testid="session-todo-added"]')).toBeVisible();

  await emitTodos([
    { id: 'fresh-1', content: 'fresh step', status: 'completed' },
    { id: 'fresh-2', content: 'added step', status: 'pending' },
  ]);
  await expect(mainWindow.locator('[data-testid="session-todo-updated"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="session-todo-added"]')).toHaveCount(0);

  await emitTodos([]);
  await expect(panel).toHaveCount(0);

  await emitTodos([{ id: 'next-1', content: 'next topic step', status: 'pending' }]);
  await expect(panel).toBeVisible();
  await expect(mainWindow.locator('[data-testid="session-todo-fresh"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="session-todo-continuation"]')).toHaveCount(0);
});
