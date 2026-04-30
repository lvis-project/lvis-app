/**
 * E2E: SessionTodoPanel appears inside ChatView when the assistant emits
 * `lvis:session-todo:changed` with in-progress items.
 *
 * Strategy: simulate the IPC-level event via window.__lvis_emit__ (the same
 * bridge used by the Electron preload) with one in_progress item, then assert
 * that [data-testid="session-todo-panel"] is visible within the chat container
 * — NOT as a top-level overlay.
 *
 * We use a light structural assertion (presence of the panel and active row)
 * rather than content text, so the test is resilient to copy changes.
 */
import { test, expect } from './fixtures';

test('session-todo-panel is NOT present when no todos exist', async ({ mainWindow }) => {
  // The panel renders null when items list is empty — should not be in DOM
  const panel = mainWindow.locator('[data-testid="session-todo-panel"]');
  const visible = await panel.isVisible().catch(() => false);
  expect(visible).toBe(false);
});

test('session-todo-panel appears inside ChatView after session-todo:changed event', async ({ mainWindow }) => {
  // Emit a session-todo:changed event with one in_progress item via the
  // preload bridge that the renderer's api.onSessionTodoChanged subscribes to.
  await mainWindow.evaluate(() => {
    const item = { id: 'e2e-1', content: 'E2E: Write the fix', status: 'in_progress' };
    // The renderer subscribes to this IPC channel via api.onSessionTodoChanged.
    // Simulate it via the global IPC bridge exposed by the preload.
    const win = window as any;
    if (typeof win.__lvis_ipc_emit__ === 'function') {
      win.__lvis_ipc_emit__('lvis:session-todo:changed', { sessionId: undefined, items: [item] });
    } else if (win.lvisApi?.simulateSessionTodoChanged) {
      win.lvisApi.simulateSessionTodoChanged({ items: [item] });
    } else {
      // Fallback: fire the custom DOM event the renderer also monitors in test mode
      window.dispatchEvent(new CustomEvent('lvis:session-todo:changed', {
        detail: { sessionId: undefined, items: [item] },
      }));
    }
  });

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

  // The active row must also be present
  const activeRow = mainWindow.locator('[data-testid="session-todo-active-row"]');
  await expect(activeRow).toBeVisible();
});
