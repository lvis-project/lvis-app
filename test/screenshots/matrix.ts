import type { ElectronApplication, Page } from 'playwright';

/**
 * Data-driven scenario matrix: one entry per docs-site screenshot key
 * (C:\Users\ikcha\workspace\lvis-project\lvisai.xyz\lib\screenshots.ts).
 *
 * Each entry is either:
 *   - capturable: `steps` navigates/injects state, `locator` (optional)
 *     scopes the capture to one element; omitted `locator` captures the
 *     full window.
 *   - `skip: "<reason>"`: honest skip — the harness cannot realistically
 *     seed this state today. See README.md "Skip list" for the categorized
 *     rationale (out-of-scope web/server screens, live OAuth, real STT,
 *     plugin UI needing the real bundle instead of the E2E stub, etc).
 *
 * Keyed by the same string keys as `shots` in screenshots.ts so a docs-site
 * key maps 1:1 to a matrix entry and an output filename `<key>.png`.
 */
export interface ScenarioContext {
  app: ElectronApplication;
  page: Page;
}

export interface ScenarioEntry {
  /** docs-site topic, mirrored from screenshots.ts for readability/grouping. */
  topic: string;
  /** Element to crop the capture to. Full-window screenshot if omitted. */
  locator?: string;
  /** Navigate/seed steps run before capture. Required unless `skip` is set. */
  steps?: (ctx: ScenarioContext) => Promise<void>;
  /** Honest skip reason. Mutually exclusive with `steps`. */
  skip?: string;
}

async function openWorkMode(page: Page): Promise<void> {
  const workToggle = page.locator('[data-testid="app-mode-work"]');
  if (await workToggle.count()) {
    await workToggle.click().catch(() => {});
  }
  await page.locator('[data-testid="chat-view-root"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function typeComposerMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill(text);
}

export const scenarios: Record<string, ScenarioEntry> = {
  // ---- chat (host app) ------------------------------------------------
  'chat-todo-queue': {
    topic: 'chat',
    skip:
      'Requires a live multi-message queue + TODO list rendered above the transcript. ' +
      'That state is produced by an in-flight LLM turn issuing todo_write / message-queue ' +
      'tool calls (see src/tools + use-message-queue hook) — not reproducible without a ' +
      'live/mocked model turn. Seeding it needs a scripted fake-provider turn; deferred.',
  },
  'chat-tool-thinking': {
    topic: 'chat',
    skip:
      'Requires an in-flight LLM tool call with streaming thinking tokens. No demo/mock ' +
      'provider path in this repo drives that render state deterministically without a ' +
      'real model turn.',
  },
  'chat-permission-llm-review': {
    topic: 'chat',
    skip:
      'LLM autonomous-review permission card renders only when the reviewer layer defers ' +
      'a HIGH-risk tool call mid-turn (src/tools/pipeline/reviewer-dispatch.ts). Needs a ' +
      'scripted tool invocation through the real pipeline; deferred.',
  },
  'chat-permission-directory': {
    topic: 'chat',
    skip:
      'Directory-level read/write permission grant dialog is triggered by a tool call ' +
      'requesting an ungranted path. Same as chat-permission-llm-review: needs a scripted ' +
      'pipeline invocation, not just UI navigation.',
  },
  'chat-permission-risk': {
    topic: 'chat',
    skip:
      'Risk-based auto/manual approval branching card requires a live tool-risk ' +
      'classification pass (src/tools/pipeline/risk-classification.ts) mid-turn.',
  },
  'chat-app-update': {
    topic: 'chat',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      // MainToolbar's badge is driven by main -> renderer IPC on
      // "lvis:update:state" (src/main/auto-updater.ts sends it via
      // mainWindow.webContents.send; shape = UpdateState in
      // src/shared/update-state.ts). Push a synthetic "available" state
      // through the real channel from the main process — same technique as
      // test/e2e/ui/seeded-electron.ts's sendRendererStreamEvent — instead of
      // a fabricated DOM event the renderer never actually listens for.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        win.webContents.send('lvis:update:state', { kind: 'available', version: '99.0.0' });
      });
      await page.locator('[data-testid="app-update-badge-available"]').waitFor({
        state: 'visible',
        timeout: 10_000,
      });
    },
    locator: '[data-testid="app-update-badge-available"]',
  },
  'chat-question-card': {
    topic: 'chat',
    skip:
      'Interactive "ask user" question card is emitted by an in-flight agent turn ' +
      '(ask_user tool). Requires a scripted fake-provider turn to reach deterministically.',
  },
  'chat-plugin-panel': {
    topic: 'chat',
    skip:
      'Plugin panel content is the plugin\'s own bundled UI (loaded via manifest `ui[].entry`). ' +
      'The shared E2E plugin seeder (test/e2e/ui/fixtures.ts seedRepositoryPlugins) stubs this ' +
      'with inert placeholder text ("E2E Plugin UI") — capturing it would produce a misleading ' +
      'screenshot, not a real one. Needs the actual plugin repo\'s built UI bundle side-loaded.',
  },

  // ---- plugin common ----------------------------------------------------
  'plugin-permission-grant': {
    topic: 'plugins',
    skip:
      'First-activation permission grant dialog fires from a real plugin\'s manifest-declared ' +
      'capabilities at first tool call. Same plugin-UI-stub limitation as chat-plugin-panel.',
  },

  // ---- local-indexer ------------------------------------------------
  'local-indexer-home': {
    topic: 'local-indexer',
    skip:
      'Plugin UI screen — needs the real lvis-plugin-local-indexer built UI bundle, not the ' +
      'E2E stub. Out of scope until a sibling checkout of that repo is wired as a seed source.',
  },
  'local-indexer-indexing': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-home, plus requires a live indexing job in progress.',
  },
  'local-indexer-add-folder': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-home.',
  },
  'local-indexer-search': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-home, plus requires a real search result with LLM-authored citations.',
  },
  'local-indexer-search-2': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-search.',
  },
  'local-indexer-search-3': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-search.',
  },
  'local-indexer-index-search': {
    topic: 'local-indexer',
    skip: 'Same as local-indexer-search.',
  },

  // ---- meeting ------------------------------------------------
  'meeting-upcoming': {
    topic: 'meeting',
    skip:
      'Plugin UI screen (lvis-plugin-meeting) — needs the real built UI bundle, plus a seeded ' +
      'upcoming-calendar-event fixture. Out of scope for this harness (see local-indexer-home).',
  },
  'meeting-minutes': {
    topic: 'meeting',
    skip: 'Plugin UI screen requiring a completed recording + generated minutes. Same limitation.',
  },
  'meeting-minutes-2': { topic: 'meeting', skip: 'Same as meeting-minutes.' },
  'meeting-minutes-3': { topic: 'meeting', skip: 'Same as meeting-minutes.' },

  // ---- integration (meeting + outlook) ------------------------------------------------
  'meeting-outlook-mail': {
    topic: 'integration',
    skip: 'Requires live Outlook OAuth + generated minutes. Plugin UI + live OAuth, both out of scope.',
  },
  'meeting-outlook-mail-2': { topic: 'integration', skip: 'Same as meeting-outlook-mail.' },

  // ---- ms-graph (Outlook) ------------------------------------------------
  'outlook-login-trigger': {
    topic: 'ms-graph',
    skip: 'Plugin UI screen requiring the real ms-graph/outlook plugin bundle (not in this workspace\'s seed set).',
  },
  'outlook-login-window': {
    topic: 'ms-graph',
    skip: 'Live Microsoft OAuth popup — cannot be seeded deterministically or without real credentials.',
  },
  'outlook-login-after': {
    topic: 'ms-graph',
    skip: 'Requires a completed live OAuth login.',
  },
  'outlook-logout': {
    topic: 'ms-graph',
    skip: 'Requires a prior live OAuth login to revoke.',
  },

  // ---- meeting (recording) ------------------------------------------------
  'meeting-record': {
    topic: 'meeting',
    skip: 'Plugin UI mini-widget for a live recording session. Plugin UI bundle out of scope.',
  },
  'meeting-record-stt': {
    topic: 'meeting',
    skip: 'Requires real STT audio pipeline streaming chunks — explicitly called out as infeasible to seed.',
  },

  // ---- work-assistant ------------------------------------------------
  'work-assistant-conflict': {
    topic: 'work-assistant',
    skip: 'Plugin UI screen (lvis-plugin-work-assistant) requiring seeded calendar-conflict data + real bundle.',
  },
  'work-assistant-conflict-2': { topic: 'work-assistant', skip: 'Same as work-assistant-conflict.' },
  'work-assistant-reminder': {
    topic: 'work-assistant',
    skip: 'Plugin UI screen requiring a scheduled reminder trigger + real bundle.',
  },
  'work-assistant-reminder-2': { topic: 'work-assistant', skip: 'Same as work-assistant-reminder.' },
  'work-assistant-meeting-end-trigger': {
    topic: 'work-assistant',
    skip: 'Plugin UI screen requiring a live meeting-end trigger + real bundle.',
  },
  'work-assistant-meeting-end-trigger-2': { topic: 'work-assistant', skip: 'Same as work-assistant-meeting-end-trigger.' },

  // ---- agent-hub plugin (host sidebar) ------------------------------------------------
  'agent-hub-my-work': {
    topic: 'agent-hub-plugin',
    skip: 'Plugin UI screen (lvis-plugin-agent-hub) requiring the real built UI bundle + seeded task board data.',
  },
  'agent-hub-team-board': { topic: 'agent-hub-plugin', skip: 'Same as agent-hub-my-work.' },

  // ---- settings (not in the docs shot list by app- prefix, but part of the smoke subset) ----
  // Not a docs-site key — included as an extra smoke-subset target proving the
  // settings surface renders. Not written into the docs `shots` map.
  '_smoke-settings-llm': {
    topic: '_smoke',
    steps: async ({ page }) => {
      const result = await page.evaluate(async () => {
        const api = (window as unknown as {
          lvisApi?: { openSettingsWindow?: (tab?: string) => Promise<{ ok: boolean; error?: string }> };
        }).lvisApi;
        if (!api?.openSettingsWindow) return { ok: false, error: 'lvisApi.openSettingsWindow missing' };
        return api.openSettingsWindow('llm');
      });
      if (!result.ok) throw new Error(`openSettingsWindow failed: ${result.error ?? 'unknown'}`);
    },
    // This scenario opens a NEW window (native settings window), so its
    // capture is handled specially in capture.spec.ts rather than via the
    // generic page-locator path other entries use.
  },
};

/**
 * mp-* / ah-* / ep-* keys (marketplace, agent-hub SERVER dashboards, lge-api
 * internal portal) are WEB/server screens per the task's explicit scope —
 * they render in a browser against a separate Next.js app, not the Electron
 * host. Deliberately absent from `scenarios` (not even as skip entries) so
 * the matrix only enumerates keys this harness could ever plausibly own.
 * See README.md "Out of scope: web/server keys" for the full list.
 */
export const WEB_SERVER_KEYS_OUT_OF_SCOPE = [
  'mp-login', 'mp-plugin', 'mp-agents', 'mp-mcp', 'mp-skills',
  'mp-publisher', 'mp-publisher-2', 'mp-admin', 'mp-admin-2', 'mp-admin-3', 'mp-admin-4', 'mp-admin-5',
  'ah-dashboard', 'ah-workboard', 'ah-worklog', 'ah-inbox', 'ah-report', 'ah-subscription',
  'ep-login', 'ep-attendance', 'ep-attendance-2', 'ep-attendance-3', 'ep-approval', 'ep-parking',
  'ep-meeting-room', 'ep-meeting-room-2', 'ep-meeting-room-3', 'ep-meeting-room-4', 'ep-meeting-room-5',
  'ep-video-call', 'ep-video-call-2', 'ep-video-call-3', 'ep-video-call-4',
  'ep-lgenie', 'ep-lgenie-2',
] as const;
