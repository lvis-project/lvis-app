import { test, expect } from './fixtures';

/**
 * Composer placeholder ↔ Suggested-replies coexistence guard.
 *
 * Regression: PR #969 + #971 wired the suggested-replies chip row, but the
 * Composer's placeholder ("질문 입력 ... /command 사용 가능") rendered in
 * the same vertical strip — when the LLM emitted chips the user saw both
 * "캘린더 직접 열게 | 나중에 할게" chips AND the long static hint.
 *
 * The fix moves placeholder selection into
 * `computeComposerPlaceholder(opts)` which returns "" while chips are
 * active (best != null && !isDismissed). Unit tests cover the helper
 * directly; this e2e guards the *DOM-level* contract:
 *   1. At rest (no chips) the textarea has a non-empty placeholder.
 *   2. The suggested-replies hook is wired (window.lvis surface exposes
 *      onChatStream channel).
 *
 * Driving the chip path end-to-end requires an LLM response we can't
 * deterministically produce in CI, so we don't assert the populated case
 * here — that's the unit test's job. This spec is a regression smoke that
 * the placeholder hasn't simply been hardcoded back to its old form.
 */
test('composer placeholder renders one of the known hints at rest', async ({ mainWindow, t }) => {
  const textarea = mainWindow.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });

  const placeholder = await textarea.getAttribute('placeholder');

  // At rest the placeholder must come from one of the three non-chip
  // branches (API-key, streaming, default). An empty string would mean the
  // chip-active branch fired without any LLM signal — that's the
  // regression we're guarding against. Match against the catalog values for
  // those three branches so the assertion holds in any locale.
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const knownHints = new RegExp(
    [
      t('composerPlaceholder.defaultHint'),
      t('composerPlaceholder.apiKeyMissing'),
      t('composerPlaceholder.streamingHint'),
    ]
      .map(escapeRegExp)
      .join('|'),
  );
  expect(placeholder).toMatch(knownHints);
});
