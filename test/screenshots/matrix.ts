import type { ElectronApplication, Page } from 'playwright';
import { openInlineSettings } from '../e2e/ui/inline-settings.js';
import type { CaptureViewport, ScriptedScript } from './fixtures.js';
import { REAL_PYTHON_CAPTURES } from './plugin-seed.js';

/**
 * Data-driven scenario matrix: one entry per docs-site screenshot key
 * (`web/lib/screenshots.ts`).
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
   * open the approval dock). Set true only for `plugin-permission-grant`, whose
   * capture target IS that approval dock.
   */
  keepReviewer?: boolean;
  /** Navigate/seed steps run before capture. Required unless `skip` is set. */
  steps?: (ctx: ScenarioContext) => Promise<void>;
  /**
   * Honest skip reason; `skip` wins over `steps` when both are present. Both is
   * the shape a scenario takes when its blocker is a machine precondition
   * rather than missing work: the steps are written and correct, and the reason
   * resolves to `undefined` on a machine that meets the precondition (see
   * `local-indexer-home`). An entry with neither is an incomplete entry and the
   * spec fails it.
   */
  skip?: string;
  /**
   * Transcript for the harness's local scripted endpoint (see fixtures.ts
   * "Scripted provider"), one entry per model call the scenario's `steps`
   * cause. Set this and the app is launched pointing at that endpoint instead
   * of a vendor it cannot reach; leave it unset for scenarios that never start
   * a turn. The spec fails the capture when the endpoint refused a request it
   * could not answer; a trailing turn the capture stopped before is not
   * checked.
   */
  scriptedScript?: ScriptedScript;
  /** Reviewer mode for the isolated profile. Plugin scenarios leave this to
   *  `plugin-seed.ts`, which already picks the mode their panel needs. */
  reviewerMode?: 'disabled' | 'rule' | 'llm' | 'strict';
  /**
   * Permission execution mode for the isolated profile. Omit for the host
   * default (`default`). `auto` is what routes a foreground shell/write/network
   * call through the reviewer before the approval dock opens — see the option's
   * JSDoc in fixtures.ts.
   */
  executionMode?: 'default' | 'strict' | 'auto' | 'allow';
  /** Fabricated files written under the isolated LVIS home before launch. */
  seededCorpus?: Readonly<Record<string, string>>;
  /** UI locale for this capture. The published docs images are Korean. */
  uiLocale?: 'ko' | 'en';
  /**
   * Window size for this capture. Omit for the harness default
   * (`CAPTURE_VIEWPORT`, 1600x1000); set it for a key whose subject is a short
   * transcript, which the default frames inside a lot of empty background.
   */
  captureViewport?: CaptureViewport;
}

async function openWorkMode(page: Page): Promise<void> {
  const workToggle = page.locator('[data-testid="app-mode-work"]');
  if (await workToggle.count()) {
    await workToggle.click().catch(() => {});
  }
  await page.locator('[data-testid="chat-view-root"]').first().waitFor({ state: 'visible', timeout: 15_000 });
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
 * in the main renderer, so the webview mounts inside mainWindow and is
 * screenshottable in either workspace mode.
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

/**
 * Type one message into the composer and send it, starting a model turn
 * against the scripted endpoint.
 */
async function sendChatMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click();
  await composer.fill(text);
  await page.locator('[data-testid="composer-send-button"]').first().click();
}

/**
 * Push one plugin overlay card through the REAL main→renderer channel.
 *
 * The `work-assistant-*` docs keys are host-rendered overlay cards, not plugin
 * panels. In production the plugin calls `hostApi.triggerConversation(spec)`
 * and the host builds an `OverlayItem` and sends it on `lvis:overlay:show`
 * (src/boot/steps/plugin-runtime/host-api-factory.ts). Firing the plugin's own
 * detector needs a live ms-graph / meeting signal, so this composes the SAME
 * item the host would compose and sends it on the SAME channel from the main
 * process — the technique `chat-app-update` already uses for `lvis:update:state`.
 * Everything downstream is the real thing: OverlayContext queues it,
 * OverlayCardRegion renders the real OverlayCard, and the primary action runs
 * the real imported-trigger insert.
 *
 * `intent` is the plugin's overlay source tag (`work_assistant.alert.<intent>`
 * → `overlay:<intent>`); the host derives the card title from it when the spec
 * carries no explicit title, which is what the published images show.
 */
async function pushPluginOverlay(
  app: ElectronApplication,
  page: Page,
  spec: { intent: string; summary: string; prompt: string },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, item) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.webContents.send('lvis:overlay:show', item);
  }, {
    id: `plugin:work-assistant:${spec.intent}`,
    source: { kind: 'plugin', pluginId: 'work-assistant', eventId: spec.intent },
    title: spec.intent,
    summary: spec.summary,
    running: false,
    // The ko string `be_pluginRuntime.overlayPrimaryActionLabel` resolves to.
    primaryActionLabel: '확인하기',
    pendingPrompt:
      `<imported-from-proactive source="overlay:${spec.intent}">
${spec.prompt}
</imported-from-proactive>`,
    createdAt: new Date().toISOString(),
  });
  await page.locator('[data-testid="overlay-card-region"]').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });
  // The card opens with the summary clamped to two lines and a "\ub354 \ubcf4\uae30" toggle.
  // The published images are clamped too, but what they clamp away is the alert
  // itself, so the frame ends up showing the feature without showing what it
  // said. Expanding is a real state of the real card, reached by clicking the
  // real control.
  await page.locator('[data-testid="overlay-card-expand-toggle"]').first().click();
}

/**
 * Everything in the captures below is invented. It is written here rather than
 * read from anywhere on the capturing machine so a frame cannot pick up a real
 * name, path, or document by accident — which is the whole reason these keys
 * are being re-shot (docs/development/screenshot-reshoot.md).
 */
const SEEDED_NOTE_PATH = 'notes/reading-list.md';
/**
 * A path deliberately outside the isolated profile's allowed scope, which is
 * exactly `cwd` plus the LVIS home (`computeDefaultAllowedDirectories`). A read
 * of it therefore reaches the allowed-directory gate. Invented, and never
 * created — the capture is of the dialog, not of a successful read.
 */
const FABRICATED_OUTSIDE_PATH =
  process.platform === 'win32'
    ? 'C:\\Users\\demo\\Documents\\reading-list.md'
    : process.platform === 'darwin'
      ? '/Users/demo/Documents/reading-list.md'
      : '/home/demo/Documents/reading-list.md';

const SEEDED_SUMMARY_PATH = 'notes/reading-list-summary.md';
const SEEDED_SUMMARY_BODY = [
  '# Reading list — earlier summary',
  '',
  'Three unrelated subjects, one line each, kept short on purpose.',
  '',
].join('\n');
const SEEDED_NOTE_BODY = [
  '# Reading list',
  '',
  '- Tides and estuaries — chapter 3 open questions',
  '- Lighthouse keeping, a short history',
  '- Notes on paper marbling',
  '',
  'Nothing here is real; this file exists so a capture has something to read.',
  '',
].join('\n');

/**
 * Fabricated work-assistant alerts.
 *
 * The published images for these keys carry a real organiser, real attendee
 * addresses and, on one, an opaque calendar event id. Everything below is
 * invented for the capture: the addresses are at `example.invalid`, which is
 * reserved by RFC 2606 and can never resolve to anyone, and the names are role
 * labels rather than person names.
 */
const WA_CONFLICT_SUMMARY = [
  '\uc0c8 \uc77c\uc815\uc774 \uae30\uc874 \uc77c\uc815\uacfc \uacb9\uce69\ub2c8\ub2e4.',
  '- \uc0c8 \uc77c\uc815: \ubd84\uae30 \ub370\ubaa8 \ub9ac\ud5c8\uc124 (14:00~15:00)',
  '- \uacb9\uce58\ub294 \uc77c\uc815 (1\uac1c):',
  '  - \ubb38\uc11c\ud654 \uc2a4\ud504\ub9b0\ud2b8 \uc810\uac80 (14:30~15:30)',
].join('\n');

const WA_PREP_SUMMARY = [
  '\uc57d 15\ubd84 \ud6c4 \uc77c\uc815\uc774 \uc2dc\uc791\ub429\ub2c8\ub2e4.',
  '- \uc81c\ubaa9: \ubd84\uae30 \ub370\ubaa8 \ub9ac\ud5c8\uc124',
  '- \uc8fc\ucd5c\uc790: \ub370\ubaa8 \uc9c4\ud589\uc790 (demo-host@example.invalid)',
  '- \uc7a5\uc18c: \uc628\ub77c\uc778',
].join('\n');

const WA_SUMMARY_SUMMARY = [
  '\ubbf8\ud305\uc774 \ubc29\uae08 \uc885\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4.',
  '- \uc81c\ubaa9: \ubd84\uae30 \ub370\ubaa8 \ub9ac\ud5c8\uc124',
  '- \uc8fc\uc694 \ub0b4\uc6a9:',
  '  - \ub370\ubaa8 \uc2dc\ub098\ub9ac\uc624 3\uac74\uc744 \ud655\uc815\ud568',
  '  - \ub179\ud654\ubcf8\uc740 \ub2e4\uc74c \uc8fc\uae4c\uc9c0\ub9cc \ubcf4\uad00\ud568',
].join('\n');

export const scenarios: Record<string, ScenarioEntry> = {
  // ---- chat (host app) ------------------------------------------------
  'chat-todo-queue': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    captureViewport: { width: 1440, height: 780 },
    // Two model calls: the first writes the session TODO list, the second is a
    // long answer streamed slowly so messages typed while it runs land in the
    // queue instead of starting a turn of their own. Both panels are then on
    // screen at once, which is what this key shows.
    scriptedScript: {
      turns: [
      {
        expect: 'assistant',
        parts: [
          {
            kind: 'tool',
            id: 'capture-todo',
            name: 'todo_session_write',
            input: {
              items: [
                { id: 't1', content: '읽을 자료 목록 정리', status: 'completed' },
                { id: 't2', content: '장별 핵심 질문 뽑기', status: 'completed' },
                { id: 't3', content: '요약 초안 작성', status: 'in_progress' },
                { id: 't4', content: '다음 주 읽을 순서 정하기', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        expect: 'assistant',
        chunkDelayMs: 200,
        parts: [
          {
            kind: 'text',
            text:
              '자료 목록부터 정리했습니다. 세 항목 모두 서로 다른 주제라 한 묶음으로 ' +
              '합치기는 어렵고, 장별로 열어 둔 질문만 따로 뽑아 두었습니다.\n\n' +
              '지금은 초안을 쓰는 중입니다. 각 주제를 두세 문장으로 줄이고, 서로 ' +
              '겹치는 부분이 있으면 표시해 두겠습니다. 초안이 끝나면 다음 주에 어떤 ' +
              '순서로 읽으면 좋을지도 같이 제안하겠습니다.',
          },
        ],
      },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '읽을 자료들 정리하고 요약 초안까지 만들어 줘.');
      await page
        .locator('[data-testid="session-todo-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      // The second turn is streaming by now. Anything sent while it runs is
      // queued rather than started, which is the state this key depicts.
      await sendChatMessage(page, '오늘 날씨는 어때?');
      await sendChatMessage(page, '점심은 뭐가 좋을까?');
      await page
        .locator('[data-testid="message-queue-panel"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      // The TODO dock collapses to a one-line focus row once a turn is under
      // way; expand it so the checklist this key is about is in frame.
      const todoPanel = page.locator('[data-testid="session-todo-panel"]').first();
      if (await todoPanel.locator('[data-testid="session-todo-collapsed-active"]').count()) {
        await todoPanel.locator('button').first().click();
      }
      // A phrase that appears only in the streamed answer, not in the checklist
      // above it — so this waits for the transcript, not for a TODO row.
      await page
        .locator('[data-testid="assistant-message-body"]')
        .first()
        .getByText('겹치는 부분이', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  'chat-tool-thinking': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    captureViewport: { width: 1440, height: 660 },
    seededCorpus: {
      [SEEDED_NOTE_PATH]: SEEDED_NOTE_BODY,
      [SEEDED_SUMMARY_PATH]: SEEDED_SUMMARY_BODY,
    },
    // The caption this key carries promises tool execution AND thinking tokens
    // arriving, so the capture has to land inside a turn, not after one: the
    // first turn reads a file, and the second streams its reasoning slowly
    // enough that the finished tool row and a growing thinking body share the
    // frame. Only the second turn has reasoning, so the "thinking..." header the
    // steps click is unambiguously the live one.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-read-notes',
              name: 'read_file',
              input: { path: SEEDED_NOTE_PATH },
              seededPathFields: ['path'],
            },
          ],
        },
        {
          expect: 'assistant',
          chunkDelayMs: 350,
          parts: [
            {
              kind: 'reasoning',
              text:
                '노트에는 세 항목이 있고 서로 주제가 달라서 한 문단으로 묶기는 어렵다. ' +
                '조석과 하구는 챕터별 질문이 남아 있고, 등대 관리와 종이 마블링은 각각 ' +
                '한 줄짜리 메모라 분량이 맞지 않는다. 이전 요약본이 남아 있는지 먼저 ' +
                '확인한 뒤 같은 형식으로 맞추는 편이 좋겠다.',
            },
            {
              kind: 'tool',
              id: 'capture-read-summary',
              name: 'read_file',
              input: { path: SEEDED_SUMMARY_PATH },
              seededPathFields: ['path'],
            },
          ],
        },
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text:
                '노트에는 세 가지 주제가 들어 있습니다. 조석과 하구, 등대 관리의 역사, ' +
                '그리고 종이 마블링 기법입니다.',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 좀 요약해 줘.');
      // The first turn's read has finished — its row carries a duration badge,
      // which only appears once the tool returned.
      await page
        .locator('[data-testid="tool-duration"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      // ReasoningCard.tsx starts collapsed and expands only on click, streaming
      // or not, so the live thinking body is behind one click. The entry is
      // still the turn's last one at this point, so it holds that open state
      // until the turn ends and the transcript re-groups it.
      const liveThinking = page.getByText('생각 중...', { exact: false }).first();
      await liveThinking.waitFor({ state: 'visible', timeout: 30_000 });
      await liveThinking.click();
      // Mid-stream by construction: this clause is roughly two thirds through
      // the scripted reasoning, so the frame is taken with a couple of lines
      // already rendered and the rest still arriving.
      await page.getByText('등대 관리와', { exact: false }).first().waitFor({
        state: 'visible',
        timeout: 20_000,
      });
    },
  },

  'chat-permission-llm-review': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'llm',
    executionMode: 'auto',
    captureViewport: { width: 1440, height: 660 },
    // The same shell call as chat-permission-risk, captured one step earlier:
    // while the reviewer's answer is still on the wire. The reviewer runs
    // BEFORE the tool starts, so no tool row exists for that toolUseId yet and
    // TranscriptRenderer's `rendersOnToolRow` is false — which is exactly the
    // case its comment reserves the standalone PermissionReviewStatusCard for.
    // `chunkDelayMs` on the reviewer turn is what holds that state open long
    // enough to wait on.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: '문서 폴더에 어떤 파일이 있는지 먼저 확인하겠습니다.',
            },
            {
              kind: 'tool',
              id: 'capture-review-shell',
              name: 'bash',
              input: { command: 'ls -la ~/Documents' },
            },
          ],
        },
        {
          expect: 'reviewer',
          chunkDelayMs: 900,
          parts: [
            {
              kind: 'text',
              text: '{ "level": "high", "reason": "reads a directory outside the allowed scope" }',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '문서 폴더에 뭐가 있는지 확인해 줘.');
      await page
        .locator('[data-testid="permission-review-status-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },

  'chat-permission-directory': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    locator: '[data-testid="approval-dock"]',
    // The reviewer is off, so nothing here is a risk verdict: this is the
    // allowed-directory gate in PermissionManager, reached by reading a path
    // outside the profile's scope. That is the dialog this key documents.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-outside-read',
              name: 'read_file',
              input: { path: FABRICATED_OUTSIDE_PATH },
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '문서 폴더에 있는 읽을 자료 목록도 같이 봐 줘.');
      const dock = page.locator('[data-testid="approval-dock"]').first();
      await dock.waitFor({ state: 'visible', timeout: 30_000 });
      // The dock summarises by default; the path evidence — requested path and
      // the directories currently in scope — is inside the review details,
      // which is what this key is about.
      await dock.locator('[data-testid="approval-review-details"]').first().click();
      await dock
        .locator('[data-testid="approval-path-grant-evidence"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
  },
  'chat-permission-risk': {
    topic: 'chat',
    uiLocale: 'ko',
    reviewerMode: 'llm',
    // `auto` is the mode this key documents — the branch where the reviewer
    // grades a shell call first and only a verdict above the auto-approve
    // threshold reaches the user. Under the default mode the dock opens
    // straight from the category rule, no classification call is made, and the
    // scripted reviewer turn below is not requested at all.
    executionMode: 'auto',
    locator: '[data-testid="approval-dock"]',
    // Same flow as chat-permission-llm-review, captured one step later: the
    // verdict has landed and the dock is showing what the risk level means for
    // this call, which is the branch this key documents.
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'tool',
              id: 'capture-shell',
              name: 'bash',
              input: { command: 'ls -la ~/Documents' },
            },
          ],
        },
        {
          expect: 'reviewer',
          parts: [
            {
              kind: 'text',
              text: '{ "level": "high", "reason": "reads a directory outside the allowed scope" }',
            },
          ],
        },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '문서 폴더에 뭐가 있는지 확인해 줘.');
      const dock = page.locator('[data-testid="approval-dock"]').first();
      await dock.waitFor({ state: 'visible', timeout: 30_000 });
      await dock.locator('[data-testid="approval-review-details"]').first().click();
      await dock
        .locator('[data-testid="approval-impact-summary"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    },
  },
  'chat-app-update': {
    topic: 'chat',
    uiLocale: 'ko',
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
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    locator: '[data-testid="ask-user-question-card"]',
    // One call: the turn parks on `ask_user_question` and waits for an answer
    // that never comes, so the card stays on screen for the capture.
    scriptedScript: {
      turns: [
      {
        expect: 'assistant',
        parts: [
          {
            kind: 'tool',
            id: 'capture-ask',
            name: 'ask_user_question',
            input: {
              questions: [
                {
                  question: '요약을 어떤 길이로 만들까요?',
                  choices: ['한 문단', '반 페이지', '한 페이지'],
                  recommendedIndex: 1,
                },
              ],
            },
          },
        ],
      },
      ],
    },
    steps: async ({ page }) => {
      await openWorkMode(page);
      await sendChatMessage(page, '노트에 정리해 둔 읽을 자료들 요약해 줘.');
      await page
        .locator('[data-testid="ask-user-question-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  'chat-plugin-panel': {
    topic: 'chat',
    skip:
      "The plugin whose panel this key shows does not load in the isolated profile: its " +
      "bundle's factory spawns a confined child before the ASRT sandbox is active there, so " +
      "the runtime tears the plugin down and no panel mounts (\"wrapWorkerCommand: ASRT " +
      "sandbox is not active\"). Recorded as reproducing on an unmodified checkout, so it is " +
      "not caused by this change; host-side and outside this harness. On a checkout with no " +
      "sibling plugin clone it fails earlier still — plugin-seed reports the bundle missing " +
      "and nothing renders.",
  },

  // ---- plugin common ----------------------------------------------------
  'plugin-permission-grant': {
    topic: 'plugins',
    plugins: ['meeting'],
    keepReviewer: true,
    uiLocale: 'ko',
    locator: '[data-testid="approval-dock"]',
    steps: async ({ page }) => {
      // With the reviewer left ON (keepReviewer), the real meeting panel's
      // mount-time `meeting_list_preps` read call is deferred to the host's
      // "Approve Tool Execution" permission dock — the plugin-first-tool-call
      // permission grant this docs key depicts. Navigate to the panel; the dock
      // appears below it, then assert the dock content.
      await openPluginPanel(page, '미팅');
      await page
        .locator('[data-testid="approval-dock"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  },

  // ---- local-indexer ------------------------------------------------
  // local-indexer's REAL bundle is side-loadable, but its compiled hostPlugin
  // `start()` hard-throws without a provisioned Python interpreter — the
  // kiwi/FTS5 worker has to be healthy before the plugin registers its UI
  // provider at all, and a fresh isolated profile has an empty runtime cache.
  //
  // `LVIS_SCREENSHOT_REAL_PYTHON=1` answers that: plugin-seed keeps the manifest
  // `python` block and fixtures hardlinks in the venv the host already
  // provisioned on this machine for the same requirements lock. No network, no
  // build, real worker.
  //
  // Two preconditions the flag does NOT create, so they are stated rather than
  // silently failed:
  //   1. A venv for this plugin's exact lock must already exist under the real
  //      `~/.lvis/runtime/python-envs/`. Running the plugin once in the real app
  //      is what puts it there.
  //   2. TCP 127.0.0.1:43129 must be free. The worker port is hardcoded
  //      (`port: options.port ?? 43129`), `hostPlugin.ts` never passes one, and
  //      the plugin's `configSchema` has no field for it — so there is no
  //      override, and a second LVIS instance on the same machine cannot start
  //      local-indexer at all. That is a real product limitation, not a harness
  //      one; it is recorded in docs/development/screenshot-reshoot.md.
  'local-indexer-home': {
    topic: 'local-indexer',
    plugins: ['local-indexer'],
    uiLocale: 'ko',
    executionMode: 'allow',
    skip: REAL_PYTHON_CAPTURES
      ? undefined
      : 'Needs a live Python worker. Re-run with LVIS_SCREENSHOT_REAL_PYTHON=1 on a '
        + 'machine that has the venv provisioned and port 43129 free (see the group '
        + 'comment above).',
    steps: async ({ page }) => {
      await openPluginPanel(page, '로컬 색인');
    },
  },
  'local-indexer-indexing': {
    topic: 'local-indexer',
    skip: 'Same live-worker preconditions as local-indexer-home, plus a live indexing job.',
  },
  'local-indexer-add-folder': {
    topic: 'local-indexer',
    skip: 'Same live-worker preconditions as local-indexer-home.',
  },
  'local-indexer-search': {
    topic: 'local-indexer',
    skip:
      'Same live-worker preconditions as local-indexer-home, plus a real search result ' +
      'with LLM-authored citations over a seeded corpus.',
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
    uiLocale: 'ko',
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
  // overlay cards emitted when a work-assistant detector fires
  // (work_assistant.alert.<intent>, see the plugin's notificationEvents +
  // decision/*-detector.ts). The DETECTOR still needs real external signals
  // (ms-graph email.new / calendar.event.conflict.detected /
  // meeting.summary.created) and the plugin ships no dev trigger to synthesize
  // them — but the detector is not what these images show. What they show is
  // the host's own card, and the host builds it in one place from one IPC
  // message, so `pushPluginOverlay` sends that exact message on that exact
  // channel and everything downstream is the production path: OverlayContext,
  // OverlayCardRegion, the real OverlayCard, and the real imported-trigger
  // insert behind the primary action. The `-2` keys click that button for real.
  // (The plugin's own detector-toggle panel is a separate surface, captured
  // under chat-plugin-panel.)
  'work-assistant-conflict': {
    topic: 'work-assistant',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'calendar-conflict-prep',
        summary: WA_CONFLICT_SUMMARY,
        prompt: WA_CONFLICT_SUMMARY,
      });
    },
  },
  'work-assistant-conflict-2': {
    topic: 'work-assistant',
    // Taller than its siblings: this reply carries both event detail blocks, and
    // a shorter frame scrolls the imported-trigger bubble — the thing that shows
    // the card's prompt became a chat turn — off the top.
    captureViewport: { width: 1440, height: 980 },
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: [
                '\uacb9\uce58\ub294 \ub450 \uc77c\uc815\uc758 \uc0c1\uc138\ub294 \uc544\ub798\uc640 \uac19\uc2b5\ub2c8\ub2e4.',
                '',
                '1. \ubd84\uae30 \ub370\ubaa8 \ub9ac\ud5c8\uc124',
                '',
                '- \uc2dc\uac04: 2026-08-27 14:00 ~ 15:00',
                '- \uc7a5\uc18c: \uc628\ub77c\uc778',
                '- \uc8fc\ucd5c\uc790: \ub370\ubaa8 \uc9c4\ud589\uc790 (demo-host@example.invalid)',
                '- \uc0c1\ud0dc: \ucc38\uc11d\uc790\uc5d0 \ubcf8\uc778 \ud3ec\ud568',
                '',
                '2. \ubb38\uc11c\ud654 \uc2a4\ud504\ub9b0\ud2b8 \uc810\uac80',
                '',
                '- \uc2dc\uac04: 2026-08-27 14:30 ~ 15:30',
                '- \uc7a5\uc18c: \ud68c\uc758\uc2e4 B',
                '- \uc8fc\ucd5c\uc790: \ubb38\uc11c \ub2f4\ub2f9 (demo-docs@example.invalid)',
                '- \uc0c1\ud0dc: \uc218\ub77d, \uc815\uae30 \uc77c\uc815',
                '',
                '\uacb9\uce58\ub294 \uad6c\uac04\uc740 30\ubd84\uc785\ub2c8\ub2e4. \uc6d0\ud558\uc2dc\uba74 \ub2e4\uc74c \uc911 \ud558\ub098\ub85c \uc774\uc5b4\uac00\uaca0\uc2b5\ub2c8\ub2e4.',
                '',
                '1. \ub9ac\ud5c8\uc124\uc744 30\ubd84 \uc55e\ub2f9\uaca8 \uacb9\uce68\uc744 \uc5c6\uc568\ub2e4',
                '2. \uc810\uac80\uc744 \ub2e4\uc74c \uc2ac\ub86f\uc73c\ub85c \ubbf8\ub8ec\ub2e4',
                '3. \uc774\ubc88\uc5d4 \uadf8\ub300\ub85c \ub454\ub2e4',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'calendar-conflict-prep',
        summary: WA_CONFLICT_SUMMARY,
        prompt: WA_CONFLICT_SUMMARY,
      });
      // The published image for this key is the state AFTER the card's primary
      // action: the staged prompt lands in chat as an imported trigger and the
      // assistant answers it. Clicking the real button is what produces it.
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },
  'work-assistant-reminder': {
    topic: 'work-assistant',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'calendar-event-prep',
        summary: WA_PREP_SUMMARY,
        prompt: WA_PREP_SUMMARY,
      });
    },
  },
  'work-assistant-reminder-2': {
    topic: 'work-assistant',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: [
                '\uc2dc\uc791 \uc804 \uc900\ube44\ud560 \uac83\uc744 \uc815\ub9ac\ud588\uc2b5\ub2c8\ub2e4.',
                '',
                '- \uc9c0\ub09c \ud68c\ucc28\uc5d0\uc11c \ub118\uc5b4\uc628 \ud56d\ubaa9 2\uac74\uc774 \uc544\uc9c1 \uc5f4\ub824 \uc788\uc2b5\ub2c8\ub2e4.',
                '- \ub370\ubaa8 \uc2dc\ub098\ub9ac\uc624 \ubb38\uc11c\ub294 \uc5b4\uc81c \uc800\ub141 \uc774\ud6c4 \ubcc0\uacbd\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.',
                '',
                '\uc9c0\uae08 \uc5f4\uc5b4\ub4dc\ub9b4\uae4c\uc694, \uc544\ub2c8\uba74 \uc694\uc57d\ub9cc \uba3c\uc800 \ubcf4\uc2dc\uaca0\uc5b4\uc694?',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'calendar-event-prep',
        summary: WA_PREP_SUMMARY,
        prompt: WA_PREP_SUMMARY,
      });
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },
  'work-assistant-meeting-end-trigger': {
    topic: 'work-assistant',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'meeting-summary',
        summary: WA_SUMMARY_SUMMARY,
        prompt: WA_SUMMARY_SUMMARY,
      });
    },
  },
  'work-assistant-meeting-end-trigger-2': {
    topic: 'work-assistant',
    // Card plus chat, without the dead space the default viewport leaves.
    captureViewport: { width: 1440, height: 820 },
    uiLocale: 'ko',
    reviewerMode: 'disabled',
    scriptedScript: {
      turns: [
        {
          expect: 'assistant',
          parts: [
            {
              kind: 'text',
              text: [
                '\ubbf8\ud305\uc774 \uc885\ub8cc\ub41c \uac83\uc73c\ub85c \ubcf4\uc774\uace0, \uc694\uc57d\ub3c4 \ucda9\ubd84\ud788 \uc815\ub9ac\ub3fc \uc788\uc2b5\ub2c8\ub2e4.',
                '\uc6d0\ud558\uc2dc\uba74 \ubc14\ub85c \ub2e4\uc74c \uc911 \ud558\ub098\ub97c \uc9c4\ud589\ud558\uaca0\uc2b5\ub2c8\ub2e4.',
                '',
                '1. \ud68c\uc758\ub85d\uc744 \uba54\uc77c\ub85c \uacf5\uc720',
                '2. \uc624\ub298 work-log \uc5d0 \uac1c\uc778 \uae30\ub85d\uc73c\ub85c \ucd94\uac00',
                '3. \ub458 \ub2e4 \ud558\uc9c0 \uc54a\uace0 \uc5ec\uae30\uc11c \uc885\ub8cc',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    steps: async ({ app, page }) => {
      await openWorkMode(page);
      await pushPluginOverlay(app, page, {
        intent: 'meeting-summary',
        summary: WA_SUMMARY_SUMMARY,
        prompt: WA_SUMMARY_SUMMARY,
      });
      await page.locator('[data-testid="overlay-card-primary-action"]').first().click();
      await page.locator('[data-testid="assistant-message-body"]').last().waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    },
  },

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
    steps: async ({ app, page }) => {
      await openInlineSettings(app, page, 'llm');
    },
  },
};

/**
 * mp-* / ah-* / ep-* keys (marketplace, agent-hub SERVER dashboards,
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
  'ep-portal', 'ep-portal-2',
] as const;
