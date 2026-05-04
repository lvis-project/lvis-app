/**
 * E2E: Agent Hub v0.2.1 — v3 IA stretch / grid-layout baseline
 *
 * Purpose:
 *   Capture a visual-geometry baseline for the ah-stack-grid layout introduced
 *   in lvis-plugin-agent-hub#70.  Unit tests (cards.test.tsx) verify rendering but do NOT measure
 *   boundingBox geometry.  These tests fill that gap so future visual regressions
 *   are caught before they ship.
 *
 * Coverage:
 *   1. 마이워크 stretch  — TodayScheduleCard height > WeeklyGantt + MyBoard combined - gap
 *   2. 팀보드 stretch    — TeamScheduleCard (reuses TodayScheduleCard testid) height
 *                         > TeamKpiCombo + TeamBoardList combined - gap
 *   3. 팀보드 summary 최상단 — agent-hub-card-team-summary y < KPI card y (above)
 *   4. 마이워크 좌측 stack 동일 폭 — weekly ≈ myboard width (±2px)
 *   5. 팀보드 좌측 stack 동일 폭 — kpi ≈ team-list width (±2px)
 *   6. ah-row-grid 1.45fr / 0.55fr 비율 — LLM card width / Approval card width ≈ 2.636
 *
 * Design notes:
 *   • All tests skip gracefully when the plugin panel is absent (build predates v0.2.1).
 *   • No time-of-day dependency — the panel is evaluated structurally, not by content.
 *   • GAP constant (12px) matches ah-stack-grid CSS gap value in v3.css.
 *   • Width tolerance for "same column" checks is ±2 px as specified in the AC.
 *   • Row-grid ratio tolerance is ±5% to absorb sub-pixel rounding across DPIs.
 */

import { test as base, expect } from '../ui/fixtures';
import { AgentHubMockServer } from './fixtures/agent-hub-mock-server';
import type { Page, Locator } from 'playwright';
import { openAgentHubTab, waitForV3Panel, waitForAuthS3, injectMockBaseUrl } from './_helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CSS gap value defined in .ah-stack-grid { gap: 12px } */
const STACK_GAP = 12;

/**
 * Expected column ratio for .ah-row-grid: 1.45fr / 0.55fr = 2.636…
 * We allow ±5% to absorb sub-pixel rounding across display densities.
 */
const ROW_GRID_RATIO = 1.45 / 0.55; // ≈ 2.636
const ROW_GRID_RATIO_TOLERANCE = 0.05; // 5%

/** Width tolerance for "same column" assertions (±2 px per acceptance criteria). */
const WIDTH_TOLERANCE_PX = 2;

/** Click the 마이워크 toggle tab and wait for the view to mount. */
async function switchToMyWork(panel: Locator, page: Page): Promise<void> {
  const btn = panel.locator('[data-testid="agent-hub-toggle-mywork"]').first();
  await btn.click();
  await page.waitForTimeout(300);
}

/** Click the 팀보드 toggle tab and wait for the view to mount. */
async function switchToTeamBoard(panel: Locator, page: Page): Promise<void> {
  const btn = panel.locator('[data-testid="agent-hub-toggle-teamboard"]').first();
  await btn.click();
  await page.waitForTimeout(300);
}

/**
 * Get boundingBox for a card by its testid.
 * Returns null when the card is not in the DOM / not visible.
 */
async function cardBox(panel: Locator, testid: string) {
  const card = panel.locator(`[data-testid="${testid}"]`).first();
  const visible = await card.isVisible().catch(() => false);
  if (!visible) return null;
  return card.boundingBox();
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixtures = { mockServer: AgentHubMockServer };

const test = base.extend<Fixtures>({
  mockServer: async ({}, use) => {
    const server = await AgentHubMockServer.start();
    await use(server);
    await server.stop();
  },
});

// ---------------------------------------------------------------------------
// Shared setup: open panel + inject mock + reach S3
// ---------------------------------------------------------------------------

async function setupPanel(
  page: Page,
  mockServer: AgentHubMockServer,
): Promise<{ panel: Locator; skip: boolean; skipReason: string }> {
  // Inject mock base URL into window BEFORE opening the tab so any fetch
  // triggered at panel mount sees the mock URL.  evaluate() works on
  // the already-loaded Electron window; page.addInitScript() does not.
  await injectMockBaseUrl(page, mockServer);

  const tabFound = await openAgentHubTab(page);
  if (!tabFound) {
    return { panel: page.locator('body'), skip: true, skipReason: 'agent-hub tab not present — build may predate v0.2.1' };
  }

  const panel = await waitForV3Panel(page);
  if (!panel) {
    return { panel: page.locator('body'), skip: true, skipReason: 'agent-hub-panel-v3 not mounted' };
  }

  const atS3 = await waitForAuthS3(panel);
  if (!atS3) {
    // Panel is in auth-gated state — geometry tests are not meaningful
    return { panel, skip: true, skipReason: 'panel toggle not enabled — auth did not reach S3 within timeout' };
  }

  return { panel, skip: false, skipReason: '' };
}

// ---------------------------------------------------------------------------
// Test 1: 마이워크 stretch — TodayScheduleCard height > WeeklyGantt + MyBoard - gap
// ---------------------------------------------------------------------------

test('마이워크: TodayScheduleCard stretches taller than WeeklyGantt + MyBoard combined', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToMyWork(panel, mainWindow);

  // Give layout a tick to settle after toggle
  await mainWindow.waitForTimeout(200);

  const todayBox = await cardBox(panel, 'agent-hub-card-today');
  const weeklyBox = await cardBox(panel, 'agent-hub-card-weekly');
  const myboardBox = await cardBox(panel, 'agent-hub-card-myboard');

  test.skip(
    !todayBox || !weeklyBox || !myboardBox,
    'One or more ah-stack-grid cards not visible — layout may not have rendered (S3 reached but data empty)',
  );

  const stretchCardHeight = todayBox!.height;
  const leftStackCombined = weeklyBox!.height + myboardBox!.height - STACK_GAP;

  expect(
    stretchCardHeight,
    `TodayScheduleCard (${stretchCardHeight}px) must be taller than ` +
    `WeeklyGantt(${weeklyBox!.height}px) + MyBoard(${myboardBox!.height}px) - gap(${STACK_GAP}px) ` +
    `= ${leftStackCombined}px — ah-stack-grid stretch is broken`,
  ).toBeGreaterThan(leftStackCombined);
});

// ---------------------------------------------------------------------------
// Test 2: 팀보드 stretch — TeamScheduleCard height > KPI + TeamBoardList - gap
// ---------------------------------------------------------------------------

test('팀보드: TeamScheduleCard stretches taller than KPI + TeamBoardList combined', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToTeamBoard(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  // TeamScheduleCard delegates to TodayScheduleCard — same testid
  const scheduleBox = await cardBox(panel, 'agent-hub-card-today');
  const kpiBox = await cardBox(panel, 'agent-hub-card-team-kpi');
  const listBox = await cardBox(panel, 'agent-hub-card-team-list');

  test.skip(
    !scheduleBox || !kpiBox || !listBox,
    'One or more 팀보드 ah-stack-grid cards not visible — data may be empty or testids differ',
  );

  const stretchCardHeight = scheduleBox!.height;
  const leftStackCombined = kpiBox!.height + listBox!.height - STACK_GAP;

  expect(
    stretchCardHeight,
    `TeamScheduleCard (${stretchCardHeight}px) must be taller than ` +
    `TeamKpiCombo(${kpiBox!.height}px) + TeamBoardList(${listBox!.height}px) - gap(${STACK_GAP}px) ` +
    `= ${leftStackCombined}px — ah-stack-grid stretch is broken on 팀보드`,
  ).toBeGreaterThan(leftStackCombined);
});

// ---------------------------------------------------------------------------
// Test 3: 팀보드 — TeamSummaryCard is above (smaller y) KPI + list cards
// ---------------------------------------------------------------------------

test('팀보드: TeamSummaryCard is positioned above the KPI and list cards', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToTeamBoard(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const summaryBox = await cardBox(panel, 'agent-hub-card-team-summary');
  const kpiBox = await cardBox(panel, 'agent-hub-card-team-kpi');
  const listBox = await cardBox(panel, 'agent-hub-card-team-list');

  test.skip(
    !summaryBox || !kpiBox || !listBox,
    'TeamSummaryCard or stack cards not visible — skipping position assertion',
  );

  // Summary card top edge (y) must be strictly less than KPI card top edge
  expect(
    summaryBox!.y,
    `TeamSummaryCard top (y=${summaryBox!.y}) must be above TeamKpiCombo top (y=${kpiBox!.y}) — ` +
    'summary must be the topmost card in 팀보드 layout',
  ).toBeLessThan(kpiBox!.y);

  expect(
    summaryBox!.y,
    `TeamSummaryCard top (y=${summaryBox!.y}) must be above TeamBoardListCard top (y=${listBox!.y})`,
  ).toBeLessThan(listBox!.y);
});

// ---------------------------------------------------------------------------
// Test 4: 좌측 stack 동일 폭 (마이워크 + 팀보드)
// ---------------------------------------------------------------------------

test('마이워크: WeeklyGanttCard and MyBoardCard share the same column width (±2px)', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToMyWork(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const weeklyBox = await cardBox(panel, 'agent-hub-card-weekly');
  const myboardBox = await cardBox(panel, 'agent-hub-card-myboard');

  test.skip(
    !weeklyBox || !myboardBox,
    'WeeklyGanttCard or MyBoardCard not visible — skipping width assertion',
  );

  const widthDiff = Math.abs(weeklyBox!.width - myboardBox!.width);

  expect(
    widthDiff,
    `WeeklyGanttCard width(${weeklyBox!.width}px) vs MyBoardCard width(${myboardBox!.width}px) ` +
    `differ by ${widthDiff}px — must be ≤ ${WIDTH_TOLERANCE_PX}px (same ah-stack-grid column)`,
  ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
});

test('팀보드: TeamKpiCombo and TeamBoardListCard share the same column width (±2px)', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToTeamBoard(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const kpiBox = await cardBox(panel, 'agent-hub-card-team-kpi');
  const listBox = await cardBox(panel, 'agent-hub-card-team-list');

  test.skip(
    !kpiBox || !listBox,
    'TeamKpiCombo or TeamBoardListCard not visible — skipping width assertion',
  );

  const widthDiff = Math.abs(kpiBox!.width - listBox!.width);

  expect(
    widthDiff,
    `TeamKpiCombo width(${kpiBox!.width}px) vs TeamBoardListCard width(${listBox!.width}px) ` +
    `differ by ${widthDiff}px — must be ≤ ${WIDTH_TOLERANCE_PX}px (same ah-stack-grid column)`,
  ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
});

// ---------------------------------------------------------------------------
// Test 5: ah-row-grid 1.45fr / 0.55fr ratio not broken
// ---------------------------------------------------------------------------

test('마이워크: ah-row-grid preserves 1.45fr/0.55fr column ratio (LLM vs Approval cards)', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToMyWork(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const llmBox = await cardBox(panel, 'agent-hub-card-llm');
  const approvalBox = await cardBox(panel, 'agent-hub-card-approval');

  test.skip(
    !llmBox || !approvalBox,
    'LlmBriefingCard or ApprovalRequestCard not visible — skipping row-grid ratio assertion',
  );

  // Both cards should have non-zero widths
  expect(llmBox!.width).toBeGreaterThan(0);
  expect(approvalBox!.width).toBeGreaterThan(0);

  const actualRatio = llmBox!.width / approvalBox!.width;
  const ratioLow = ROW_GRID_RATIO * (1 - ROW_GRID_RATIO_TOLERANCE);
  const ratioHigh = ROW_GRID_RATIO * (1 + ROW_GRID_RATIO_TOLERANCE);

  expect(
    actualRatio,
    `ah-row-grid column ratio LLM/Approval = ${actualRatio.toFixed(3)} ` +
    `is outside expected range [${ratioLow.toFixed(3)}, ${ratioHigh.toFixed(3)}] ` +
    `(expected ≈ ${ROW_GRID_RATIO.toFixed(3)} for 1.45fr/0.55fr) — ` +
    'ah-row-grid grid-template-columns may have been changed',
  ).toBeGreaterThanOrEqual(ratioLow);

  expect(
    actualRatio,
    `ah-row-grid column ratio LLM/Approval = ${actualRatio.toFixed(3)} ` +
    `exceeds expected range high bound ${ratioHigh.toFixed(3)}`,
  ).toBeLessThanOrEqual(ratioHigh);
});

// ---------------------------------------------------------------------------
// Test 6: AH-2 — LLM card spans full row 1 when approval count = 0
// ---------------------------------------------------------------------------

test('마이워크: when approval count = 0, LLM card spans full row 1', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  await switchToMyWork(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const approvalCard = panel.locator('[data-testid="agent-hub-card-approval"]').first();
  const approvalVisible = await approvalCard.isVisible().catch(() => false);

  // Only meaningful when approval card is absent (count = 0 state from mock)
  test.skip(
    approvalVisible,
    'ApprovalRequestCard is visible — mock returned approvals; skipping zero-approval geometry test',
  );

  const llmBox = await cardBox(panel, 'agent-hub-card-llm');
  test.skip(!llmBox, 'LlmBriefingCard not visible — skipping geometry assertion');

  const rowGrid = panel.locator('.ah-row-grid').first();
  const rowGridBox = await rowGrid.boundingBox();
  test.skip(!rowGridBox, 'ah-row-grid container not found');

  // LLM card wrapper must span the full grid width (within 4px tolerance for borders/padding)
  expect(
    llmBox!.width,
    `LLM card width (${llmBox!.width}px) must equal ah-row-grid width (${rowGridBox!.width}px) ` +
    'when approval count = 0 — ah-llm-card-full grid-column:1/-1 not applied',
  ).toBeGreaterThanOrEqual(rowGridBox!.width - 4);
});

// ---------------------------------------------------------------------------
// Test 7: AH-6 — 일정 카드 3 visible avatars + 4th is overflow indicator
// ---------------------------------------------------------------------------

test('일정: 3 avatars visible + 4th is overflow indicator', async ({
  mainWindow,
  mockServer,
}) => {
  const { panel, skip, skipReason } = await setupPanel(mainWindow, mockServer);
  test.skip(skip, skipReason);

  // Switch to 팀보드 which renders TodayScheduleCard with showAttendees=true
  await switchToTeamBoard(panel, mainWindow);
  await mainWindow.waitForTimeout(200);

  const todayCard = panel.locator('[data-testid="agent-hub-card-today"]').first();
  const cardVisible = await todayCard.isVisible().catch(() => false);
  test.skip(!cardVisible, 'TodayScheduleCard not visible in 팀보드 — skipping avatar geometry test');

  // Find any schedule item that has 4+ attendees rendered
  const avatarGroups = todayCard.locator('.ah-ts-avatars');
  const groupCount = await avatarGroups.count();
  test.skip(groupCount === 0, 'No attendee avatar groups found — mock data may have no attendees');

  // For each group with overflow indicator: verify at most 3 named avatars before the +N chip
  let foundOverflowGroup = false;
  for (let g = 0; g < groupCount; g++) {
    const group = avatarGroups.nth(g);
    const overflowChip = group.locator('[aria-label^="외 "]').first();
    const hasOverflow = await overflowChip.isVisible().catch(() => false);
    if (!hasOverflow) continue;

    foundOverflowGroup = true;
    const allAvatars = group.locator('.ah-ts-avatar');
    const totalAvatarElements = await allAvatars.count();

    // With MAX_AVATARS=3: visible = 3, overflow chip = 1 → total avatar elements ≤ 4
    expect(
      totalAvatarElements,
      `Avatar group has ${totalAvatarElements} .ah-ts-avatar elements — ` +
      'expected ≤ 4 (3 visible + 1 overflow chip) with MAX_AVATARS=3',
    ).toBeLessThanOrEqual(4);

    // Named avatars (excluding overflow chip) must be ≤ 3
    const namedAvatars = totalAvatarElements - 1; // subtract the overflow chip
    expect(
      namedAvatars,
      `${namedAvatars} named avatars visible — must be ≤ 3 (MAX_AVATARS=3)`,
    ).toBeLessThanOrEqual(3);

    break; // one group with overflow is sufficient
  }

  test.skip(!foundOverflowGroup, 'No avatar group with overflow indicator found — all meetings have ≤ 3 attendees in mock data');
});
