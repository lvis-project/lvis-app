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
  /**
   * Manifest ids of REAL plugins to side-load before launch (e.g.
   * `['local-indexer']`). Their built `dist/` UI bundle is copied from the
   * sibling `../lvis-plugin-<id>/` repo so the actual plugin UI renders — see
   * `plugin-seed.ts` / `fixtures.ts`. Omit for host-only scenarios.
   */
  plugins?: readonly string[];
  /**
   * Keep the LLM permission reviewer ON for this scenario (default: it is
   * disabled whenever `plugins` is set, so panel mount-time read tools don't
   * pop the approval modal). Set true only for `plugin-permission-grant`, whose
   * capture target IS that approval modal.
   */
  keepReviewer?: boolean;
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

/**
 * Open a seeded plugin's sidebar panel via the composer command popover, then
 * wait for its UI bundle to render inside the plugin webview.
 *
 * Navigation reflects the CURRENT app (#1311 removed the standalone plugin-grid
 * button from the input area — plugins now live inside the slash / command
 * popover, see SlashPickerPanel.tsx): Ctrl/Cmd+K opens the popover →
 * `slash-picker-cat-plugin` category → the plugin's row (matched by its
 * manifest displayName label) → `onSelectPlugin(viewKey)`. In WORK mode (the
 * harness default) `handleViewSelect` opens the panel INLINE via `setActiveView`
 * (chat mode would detach into a separate window), so the webview mounts inside
 * mainWindow and is screenshottable.
 *
 * The plugin UI loads inside an Electron <webview> (plugin-ui-host.tsx) whose
 * guest content is the plugin's real bundle served over `lvis-plugin://asset`.
 * Playwright cannot pierce a <webview>'s guest document with `.locator`, so we
 * wait for the <webview> element to attach + finish loading and give the guest
 * a settle beat, then screenshot the host panel region (which contains it).
 *
 * @param label the plugin's manifest `ui[].displayName` (its row label in the
 *   picker), e.g. "미팅" for meeting or "업무 도우미" for work-assistant.
 */
async function openPluginPanel(page: Page, label: string): Promise<void> {
  await openWorkMode(page);

  // Open the command popover (Ctrl/Cmd+K). The composer must be focused first
  // so the global shortcut is in scope.
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+k`);

  const picker = page.locator('[data-testid="slash-picker"]').first();
  await picker.waitFor({ state: 'visible', timeout: 15_000 });

  // Drill into the "plugin" category, then click the plugin's row by its label.
  const pluginCat = page.locator('[data-testid="slash-picker-cat-plugin"]').first();
  await pluginCat.waitFor({ state: 'visible', timeout: 15_000 });
  await pluginCat.click();

  const pluginGroup = page.locator('[data-testid="slash-group-plugin"]').first();
  await pluginGroup.waitFor({ state: 'visible', timeout: 15_000 });
  const row = pluginGroup.locator('[cmdk-item]').filter({ hasText: label }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();

  // The plugin panel host mounts a <webview>. Wait for it to attach + finish
  // its first load; the guest bundle then renders its own DOM inside.
  const webview = page.locator('webview').first();
  await webview.waitFor({ state: 'visible', timeout: 30_000 });
  // Give the guest bundle a settle beat to paint its initial (empty-state) UI
  // after did-finish-load. No host-observable signal crosses the <webview>
  // boundary, so a fixed settle is the pragmatic wait here.
  await page.waitForTimeout(2_500);
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
    plugins: ['work-assistant'],
    steps: async ({ page }) => {
      // A real plugin's own bundled panel UI rendered inside the host, loaded via
      // manifest `ui[].entry` from the REAL lvis-plugin-work-assistant dist (not
      // the E2E "E2E Plugin UI" stub). Shows the work-assistant "스마트 감지"
      // detector-toggle panel — the plugin's actual UI bundle in a webview.
      await openPluginPanel(page, '업무 도우미');
    },
  },

  // ---- plugin common ----------------------------------------------------
  'plugin-permission-grant': {
    topic: 'plugins',
    plugins: ['meeting'],
    keepReviewer: true,
    locator: '[data-testid="tool-approval-dialog"]',
    steps: async ({ page }) => {
      // With the reviewer left ON (keepReviewer), the real meeting panel's
      // mount-time `meeting_list_preps` read call is deferred to the host's
      // "Approve Tool Execution" permission modal — the plugin-first-tool-call
      // permission grant this docs key depicts. Navigate to the panel; the modal
      // appears over it. (openPluginPanel's own webview wait still succeeds — the
      // webview attaches under the modal — then we assert the modal.)
      await openPluginPanel(page, '미팅');
      await page
        .locator('[data-testid="tool-approval-dialog"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  },

  // ---- local-indexer ------------------------------------------------
  // local-indexer's REAL bundle IS side-loadable (its manifest + dist copy in
  // via plugin-seed.ts and the plugin *loads*), but its compiled hostPlugin
  // `start()` hard-throws "localIndexerPlugin: pythonExecutable이 설정되지
  // 않았습니다" without a provisioned Python interpreter (host
  // PythonRuntimeBootstrapper.ensureReady() is not run in this test env, and the
  // bundle requires the kiwi/FTS5 Python worker even to expose its UI provider).
  // The runtime tears the plugin down after the start failure, so no UI provider
  // registers and the panel is unreachable. Provisioning a real Python runtime +
  // native deps (kiwipiepy, FTS5) is heavy and out of scope for a screenshot
  // harness. Verified: dist/src/main/main.js:~178046 (runStartWithTimeout →
  // localIndexerPlugin start throw). Kept skipped honestly.
  'local-indexer-home': {
    topic: 'local-indexer',
    skip:
      'Real lvis-plugin-local-indexer bundle loads but its start() hard-throws without a ' +
      'provisioned Python interpreter (pythonExecutable not set — PythonRuntimeBootstrapper ' +
      'is not run in this harness), so the plugin is torn down and its UI provider never ' +
      'registers. Needs a real Python worker (kiwi/FTS5) — out of scope for a screenshot harness.',
  },
  'local-indexer-indexing': {
    topic: 'local-indexer',
    skip: 'Same Python-runtime blocker as local-indexer-home, plus requires a live indexing job.',
  },
  'local-indexer-add-folder': {
    topic: 'local-indexer',
    skip: 'Same Python-runtime blocker as local-indexer-home.',
  },
  'local-indexer-search': {
    topic: 'local-indexer',
    skip:
      'Same Python-runtime blocker as local-indexer-home, plus requires a real search result ' +
      'with LLM-authored citations.',
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
    plugins: ['meeting'],
    steps: async ({ page }) => {
      // Real lvis-plugin-meeting UI. The panel's default tab ("예정 회의" /
      // upcoming) renders its empty-state (no seeded calendar events — that
      // would need ms-graph). Honest: this captures the upcoming-meeting panel
      // in its no-events state, not a populated agenda.
      await openPluginPanel(page, '미팅');
    },
  },
  'meeting-minutes': {
    topic: 'meeting',
    skip:
      'The real lvis-plugin-meeting panel loads and is captured by meeting-upcoming, but the ' +
      '"회의록" (minutes) tab and a populated minutes body live INSIDE the plugin <webview> guest ' +
      'DOM (Playwright cannot click through a <webview> to switch its internal tab) AND require a ' +
      'completed STT recording + generated minutes to populate — infeasible to seed (see ' +
      'meeting-record-stt). Capturing the default tab under this key would be a misleading duplicate ' +
      'of meeting-upcoming.',
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
    skip:
      'The real lvis-plugin-ms-graph bundle IS side-loadable, but its manifest declares ' +
      '`auth.loginTool: msgraph_auth`, so selecting the Outlook panel while unauthed goes ' +
      'straight to the live Microsoft OAuth window (use-plugin-view-routing.ts handleViewSelect ' +
      'calls loginTool on select for auth plugins) rather than rendering an inline pre-login ' +
      'panel. Reaching a stable, non-OAuth trigger state needs a real/mocked auth session — ' +
      'out of scope (see outlook-login-window).',
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
    skip:
      'The live-recording mini-widget is a separate detached BrowserWindow the meeting plugin ' +
      'opens only after meeting_start begins a session (needs an active audio device / injected ' +
      'PCM chunks); its waveform/transcript render is meaningless without a real audio source. ' +
      'The real meeting panel itself is captured by meeting-upcoming.',
  },
  'meeting-record-stt': {
    topic: 'meeting',
    skip: 'Requires real STT audio pipeline streaming chunks — explicitly called out as infeasible to seed.',
  },

  // ---- work-assistant ------------------------------------------------
  // These six keys are NOT plugin-panel screens — they are host-rendered
  // notification cards (OS toast + host overlay) emitted when a work-assistant
  // detector fires (work_assistant.alert.<intent>, see the plugin's
  // notificationEvents + decision/*-detector.ts). Firing a detector needs real
  // external signals (ms-graph email.new / calendar.event.conflict.detected /
  // meeting.summary.created events) — the work-assistant src has NO dev/test
  // trigger tool to synthesize them (verified: no demo/mock/seed IPC path in
  // lvis-plugin-work-assistant/src). The plugin's own detector-toggle PANEL does
  // render with the real bundle and is captured under chat-plugin-panel; these
  // card states remain unreachable without a live upstream event source.
  'work-assistant-conflict': {
    topic: 'work-assistant',
    skip:
      'Host-rendered notification card (work_assistant.alert.calendar-conflict-prep), not a plugin ' +
      'panel. Fires only on a real calendar.event.conflict.detected signal from ms-graph; no ' +
      'dev/test trigger exists in the work-assistant plugin to synthesize it.',
  },
  'work-assistant-conflict-2': { topic: 'work-assistant', skip: 'Same as work-assistant-conflict — host card needing a live external signal.' },
  'work-assistant-reminder': {
    topic: 'work-assistant',
    skip:
      'Host-rendered reminder notification card, not a plugin panel. Needs a real scheduled/upstream ' +
      'trigger (ms-graph/meeting event); no dev/test synthesizer exists in the plugin.',
  },
  'work-assistant-reminder-2': { topic: 'work-assistant', skip: 'Same as work-assistant-reminder — host card needing a live external signal.' },
  'work-assistant-meeting-end-trigger': {
    topic: 'work-assistant',
    skip:
      'Host-rendered meeting-end notification card, not a plugin panel. Fires on a real ' +
      'meeting.summary.created / meeting.ended event from the meeting plugin; no dev/test trigger exists.',
  },
  'work-assistant-meeting-end-trigger-2': { topic: 'work-assistant', skip: 'Same as work-assistant-meeting-end-trigger — host card needing a live external signal.' },

  // ---- agent-hub plugin (host sidebar) ------------------------------------------------
  'agent-hub-my-work': {
    topic: 'agent-hub-plugin',
    skip:
      'No agent-hub plugin bundle exists in this workspace — there is no lvis-plugin-agent-hub ' +
      'repo, and no plugin.json anywhere declares a ui extension named my-work / team-board / ' +
      'agent-hub (verified by scanning every lvis-plugin-*/plugin.json). Nothing to side-load.',
  },
  'agent-hub-team-board': { topic: 'agent-hub-plugin', skip: 'Same as agent-hub-my-work — no agent-hub bundle exists.' },

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
