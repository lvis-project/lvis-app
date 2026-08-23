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
  // The card opens with the summary clamped to two lines and a "더 보기" toggle.
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
 * The x-fraction of each sub-tab in the meeting plugin's minutes detail view,
 * measured against the `<webview>` box in the 1120x1000 capture. They sit in one
 * row, so a single shared y-fraction addresses all three.
 */
const MINUTES_SUB_TAB = {
  /** The final summary, highlights and action items. */
  summary: '회의록',
  /** The intermediate summaries, one per covered prefix of the transcript. */
  intermediate: '중간 리파인',
  /** The per-speaker transcript. */
  transcript: '전사',
} as const;

/**
 * One minutes capture, differing only in which sub-tab ends up selected.
 *
 * The minutes view was previously recorded as unreachable on two counts, both of
 * which were wrong. Playwright cannot reach a control inside a `<webview>`, but
 * the main process can — see `clickInPluginGuest`. The second count, that a
 * populated minutes body needs a
 * completed STT recording, was aiming past the store: `SessionStore` keeps one
 * JSON file per finished session under `<pluginDataDir>/sessions/`, so a
 * fabricated finalised session seeds the same state a real recording would have
 * left, with no audio anywhere in the path.
 */
function meetingMinutesScenario(subTab: (typeof MINUTES_SUB_TAB)[keyof typeof MINUTES_SUB_TAB]): ScenarioEntry {
  return {
    topic: 'meeting',
    plugins: ['meeting'],
    uiLocale: 'ko',
    // Same approval-dock reason as meeting-upcoming.
    executionMode: 'allow',
    // Same guest-overflow reason as meeting-upcoming.
    captureViewport: { width: 1120, height: 1000 },
    seededCorpus: {
      'plugins/meeting/data/sessions/demo-quarterly-rehearsal-0001.json':
        fabricatedMeetingSession(),
    },
    steps: async ({ app, page }) => {
      await openPluginPanel(page, '미팅');
      // The right-hand tab of the guest's two-tab bar, then the seeded session's
      // row in the list it reveals, then the sub-tab this capture is about. Each
      // step waits for the control the previous one produced, so a broken chain
      // names the link that broke instead of capturing a half-rendered frame.
      await waitInPluginGuest(app, '.nav-btn', { text: '회의록', click: true });
      await waitInPluginGuest(app, '.session-card', {
        text: FABRICATED_MEETING_TITLE,
        click: true,
      });
      await waitInPluginGuest(app, '.sub-tab', { text: subTab, click: true });
      await page.waitForTimeout(1_500);
    },
  };
}

/**
 * The title the fabricated meeting carries through the prep store, the session
 * store, and the row the capture clicks to open it.
 */
const FABRICATED_MEETING_TITLE = '분기 데모 리허설';

/**
 * Wait for a control inside a plugin `<webview>` guest, named by CSS selector
 * and — when a selector alone is ambiguous — by its own visible text, and
 * optionally click it.
 *
 * Playwright cannot reach into a `<webview>`: from the renderer's side the guest
 * is an opaque element with no children, so nothing in it has a locator. The
 * main process can. Electron's `webContents.getAllWebContents()` hands back the
 * guest as a first-class `WebContents` and `executeJavaScript` runs in its
 * document — the same channel the harness already uses to drive the app through
 * real IPC, pointed one frame deeper.
 *
 * Synthesised mouse events at window coordinates are the obvious alternative and
 * were tried first. They do reach the guest, but not dependably: clicks measured
 * against the same frame activated one control and passed straight through the
 * one 40px above it. That makes coordinates an unreliable way to name a control
 * even when the geometry has been verified. A selector has no such failure mode,
 * it says what is being addressed rather than where, and — unlike a blind
 * settle — it fails loudly when the guest never renders the control at all.
 */
async function waitInPluginGuest(
  app: ElectronApplication,
  selector: string,
  options: { text?: string; click?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const { text, click = false, timeoutMs = 20_000 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await app.evaluate(
      async ({ webContents }, target) => {
        const guests = webContents
          .getAllWebContents()
          .filter((contents) => contents.getType() === 'webview');
        for (const guest of guests) {
          const found = await guest.executeJavaScript(
            `(() => {
               const nodes = Array.from(document.querySelectorAll(${JSON.stringify(target.selector)}));
               const wanted = ${JSON.stringify(target.text ?? null)};
               const node = wanted === null
                 ? nodes[0]
                 : nodes.find((n) => (n.textContent || '').includes(wanted));
               if (!node) return false;
               if (${target.click ? 'true' : 'false'}) node.click();
               return true;
             })()`,
          );
          if (found) return true;
        }
        return false;
      },
      { selector, text, click },
    );
    if (hit) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitInPluginGuest: no ${selector}${text ? ` matching "${text}"` : ''} in any plugin guest after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * A fabricated finished meeting for the meeting plugin's session store.
 *
 * `SessionStore` writes one JSON file per session under
 * `<pluginDataDir>/sessions/<sessionId>.json`, which the harness's
 * `seededCorpus` can write directly the same way it writes the prep.
 *
 * Everything is invented. The published minutes captures carry a real meeting's
 * transcript verbatim, so there is nothing in them to preserve — what has to
 * survive is the SHAPE the three minutes tabs render: a final summary with
 * highlights and action items, a set of intermediate summaries each covering a
 * growing prefix of the transcript, and a transcript with more than one speaker
 * so the per-speaker layout is visible. One session covers all three.
 */
function fabricatedMeetingSession(): string {
  const started = new Date();
  started.setDate(started.getDate() - 1);
  started.setHours(14, 0, 0, 0);
  const ended = new Date(started.getTime() + 42 * 60 * 1000);
  const seg = (
    i: number,
    speaker: string,
    original: string,
    startSec: number,
    endSec: number,
  ) => ({
    id: `seg-${i}`,
    speaker,
    original,
    startSec,
    endSec,
    isFinal: true,
    source: 'streaming',
    createdAt: new Date(started.getTime() + startSec * 1000).toISOString(),
  });
  return JSON.stringify({
    sessionId: 'demo-quarterly-rehearsal-0001',
    context: {
      id: 'demo-quarterly-rehearsal',
      title: FABRICATED_MEETING_TITLE,
      locale: 'ko',
      organizer: '데모 진행자',
      participants: ['문서 담당', '지원 담당'],
      category: '정기 회의',
      scheduledStart: started.toISOString(),
      scheduledEnd: ended.toISOString(),
      location: '온라인',
    },
    category: '정기 회의',
    transcript: [
      seg(1, '데모 진행자', '오늘은 다음 주 데모에서 보여줄 순서부터 정하고, 남는 시간에 녹화본 이야기를 하겠습니다.', 0, 11),
      seg(2, '문서 담당', '시나리오는 세 개까지만 두는 게 좋겠습니다. 지난번처럼 다섯 개를 넣으면 준비 시간이 모자랍니다.', 12, 26),
      seg(3, '데모 진행자', '그러면 설치, 첫 실행, 복구 이렇게 세 건으로 가겠습니다. 나머지는 질문이 나오면 즉석에서 보여주죠.', 27, 38),
      seg(4, '지원 담당', '녹화본 보관 기간도 정해야 합니다. 지금은 기한 없이 쌓이고 있어서 용량이 계속 늘고 있습니다.', 39, 52),
      seg(5, '데모 진행자', '다음 주까지만 보관하고, 지나면 지웁니다. 필요하면 그 전에 따로 내려받아 두세요.', 53, 64),
      seg(6, '문서 담당', '그럼 시나리오 문서는 제가 오늘 중으로 갱신해서 공유하겠습니다. 화면 캡처도 새로 넣겠습니다.', 65, 78),
      seg(7, '지원 담당', '보관 기간은 제가 공지로 알리겠습니다. 안내문에 삭제 예정일을 같이 적어 두겠습니다.', 79, 90),
      seg(8, '데모 진행자', '남은 항목은 다음 회차로 넘기고 오늘은 여기까지 하겠습니다. 수고하셨습니다.', 91, 102),
    ],
    intermediateSummaries: [
      {
        coveredSegmentCount: 3,
        data: {
          summary: '데모에서 보여줄 순서를 먼저 정했습니다. 시나리오 수를 줄이자는 의견이 나와 설치, 첫 실행, 복구 세 건으로 좁혔습니다.',
          highlights: [
            '시나리오를 세 건으로 줄이자는 제안이 나옴',
            '설치 · 첫 실행 · 복구 순서로 진행하기로 함',
            '나머지는 질문이 나올 때 즉석에서 보여주기로 함',
          ],
          coveredSegmentIds: ['seg-1', 'seg-2', 'seg-3'],
          createdAt: new Date(started.getTime() + 15 * 60 * 1000).toISOString(),
        },
      },
      {
        coveredSegmentCount: 5,
        data: {
          summary: '녹화본이 기한 없이 쌓여 용량이 늘고 있다는 문제가 제기되어, 보관 기간을 다음 주까지로 정했습니다.',
          highlights: [
            '녹화본이 기한 없이 누적되어 용량이 증가',
            '보관 기간을 다음 주까지로 제한하기로 함',
            '필요한 파일은 삭제 전에 각자 내려받기로 함',
          ],
          coveredSegmentIds: ['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5'],
          createdAt: new Date(started.getTime() + 25 * 60 * 1000).toISOString(),
        },
      },
    ],
    finalized: true,
    finalSummary: {
      title: FABRICATED_MEETING_TITLE,
      summary: [
        '데모 순서를 먼저 확정하고, 녹화본 보관 기간을 짧게 가져가기로 했습니다.',
        '남은 항목은 다음 회차로 넘깁니다.',
      ].join('\n'),
      highlights: [
        '데모 시나리오 3건으로 확정',
        '녹화본은 다음 주까지만 보관',
      ],
      actionItems: [
        '데모 시나리오 문서 갱신 — 문서 담당',
        '보관 기간 안내 공지 — 지원 담당',
      ],
      createdAt: ended.toISOString(),
      lengthTier: 'medium',
    },
    createdAt: started.toISOString(),
    updatedAt: ended.toISOString(),
  });
}

/**
 * A fabricated upcoming meeting for the meeting plugin's prep store.
 *
 * `PrepStore` reads one JSON file, `{ preps: StoredPrep[] }`, at
 * `<pluginsRoot>/meeting/data/preps.json` — which under the isolated profile is
 * `plugins/meeting/data/preps.json` relative to the LVIS home, so the harness's
 * existing `seededCorpus` writes it and no second seeding hook is needed.
 *
 * The published capture of this panel is the worst image in the whole set: three
 * real names with their grades and organisational paths, and a live conference
 * URL printed alongside its meeting password, meeting key and host key. Nothing
 * below is real. The times are computed relative to the run so the meeting stays
 * "upcoming" forever rather than ageing out of the list.
 */
function fabricatedMeetingPrep(): string {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(14, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const joinUrl = 'https://conference.example.invalid/j/demo-rehearsal';
  return JSON.stringify({
    preps: [
      {
        id: 'demo-quarterly-rehearsal',
        title: FABRICATED_MEETING_TITLE,
        locale: 'ko',
        organizer: '데모 진행자',
        participants: ['문서 담당', '지원 담당'],
        category: '정기 회의',
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        location: '온라인',
        description: [
          'JOIN THE DEMO CONFERENCE',
          `JOIN URL : ${joinUrl}`,
          'Meeting Password : (발급 예정)',
          'Host : (발급 예정)',
        ].join('\n'),
        conference: {
          type: 'other',
          joinUrl,
          hostDisplayName: '데모 진행자',
        },
        agenda: [
          '데모 시나리오 3건 확정',
          '녹화본 보관 기간 정하기',
        ],
        previousSummary: {
          title: '지난 회차 요약',
          summary: [
            '데모 순서를 먼저 정하고 나머지를 다음으로 넘겼습니다.',
            '넘어온 항목 2건은 아직 열려 있습니다.',
          ].join('\n'),
        },
      },
    ],
  });
}

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
  '새 일정이 기존 일정과 겹칩니다.',
  '- 새 일정: 분기 데모 리허설 (14:00~15:00)',
  '- 겹치는 일정 (1개):',
  '  - 문서화 스프린트 점검 (14:30~15:30)',
].join('\n');

const WA_PREP_SUMMARY = [
  '약 15분 후 일정이 시작됩니다.',
  '- 제목: 분기 데모 리허설',
  '- 주최자: 데모 진행자 (demo-host@example.invalid)',
  '- 장소: 온라인',
].join('\n');

const WA_SUMMARY_SUMMARY = [
  '미팅이 방금 종료되었습니다.',
  '- 제목: 분기 데모 리허설',
  '- 주요 내용:',
  '  - 데모 시나리오 3건을 확정함',
  '  - 녹화본은 다음 주까지만 보관함',
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
    // The panel lists preps through its own `meeting_list_preps` tool. Left at
    // the default, that call raises the approval dock over the lower half of the
    // frame — the half holding the agenda and the join controls this image
    // exists to show. Approving it is not what the shot is about.
    executionMode: 'allow',
    // Narrower than the default, and load-bearing rather than cosmetic. The
    // page shell caps a plugin view at its 58rem reading column, and this guest
    // reserves a fixed left gutter inside its own viewport: measured at a
    // 1600px window the <webview> is 912px, the guest starts its card 481px in
    // and lays it out 477px wide, so the last 46px — the right edge of every
    // card and control — falls off the element. At 1120px the <webview> is
    // 833px, which is the ~800px the host comment in `plugin-ui-host.tsx` says
    // these panels were authored for, and everything fits. The overflow is a
    // real responsive bug in the plugin guest, not a harness artefact; it is
    // recorded in docs/development/screenshot-reshoot.md for the plugin repo.
    captureViewport: { width: 1120, height: 1000 },
    seededCorpus: { 'plugins/meeting/data/preps.json': fabricatedMeetingPrep() },
    steps: async ({ app, page }) => {
      // Real lvis-plugin-meeting UI, default tab ("예정 회의" / upcoming),
      // reading the fabricated prep the corpus wrote into its own store.
      await openPluginPanel(page, '미팅');
      // Waits for the prep itself rather than a fixed settle: the card renders
      // only once `meeting_list_preps` returns, and that round trip is the slow
      // part. If the seeding ever stops landing, this says so.
      await waitInPluginGuest(app, '.pm-title', { text: FABRICATED_MEETING_TITLE });
      await page.waitForTimeout(1_000);
    },
  },
  // The three minutes captures are the same scenario with a different sub-tab
  // selected, so they share one builder rather than three near-copies.
  'meeting-minutes': meetingMinutesScenario(MINUTES_SUB_TAB.summary),
  'meeting-minutes-2': meetingMinutesScenario(MINUTES_SUB_TAB.intermediate),
  'meeting-minutes-3': meetingMinutesScenario(MINUTES_SUB_TAB.transcript),

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
                '겹치는 두 일정의 상세는 아래와 같습니다.',
                '',
                '1. 분기 데모 리허설',
                '',
                '- 시간: 2026-08-27 14:00 ~ 15:00',
                '- 장소: 온라인',
                '- 주최자: 데모 진행자 (demo-host@example.invalid)',
                '- 상태: 참석자에 본인 포함',
                '',
                '2. 문서화 스프린트 점검',
                '',
                '- 시간: 2026-08-27 14:30 ~ 15:30',
                '- 장소: 회의실 B',
                '- 주최자: 문서 담당 (demo-docs@example.invalid)',
                '- 상태: 수락, 정기 일정',
                '',
                '겹치는 구간은 30분입니다. 원하시면 다음 중 하나로 이어가겠습니다.',
                '',
                '1. 리허설을 30분 앞당겨 겹침을 없앨다',
                '2. 점검을 다음 슬롯으로 미룬다',
                '3. 이번엔 그대로 둔다',
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
                '시작 전 준비할 것을 정리했습니다.',
                '',
                '- 지난 회차에서 넘어온 항목 2건이 아직 열려 있습니다.',
                '- 데모 시나리오 문서는 어제 저녁 이후 변경이 없습니다.',
                '',
                '지금 열어드릴까요, 아니면 요약만 먼저 보시겠어요?',
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
                '미팅이 종료된 것으로 보이고, 요약도 충분히 정리돼 있습니다.',
                '원하시면 바로 다음 중 하나를 진행하겠습니다.',
                '',
                '1. 회의록을 메일로 공유',
                '2. 오늘 work-log 에 개인 기록으로 추가',
                '3. 둘 다 하지 않고 여기서 종료',
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
