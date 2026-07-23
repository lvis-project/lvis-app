/**
 * CDP layout audit of the meeting + local-indexer plugin panels in CHAT mode
 * (and WORK mode as the baseline for comparison).
 *
 * After PR #1703 plugin views render INLINE in every appMode (no detached
 * window). Both plugins here are `slot: "sidebar"` UI extensions; note that
 * `kind: "embedded-module"` (local-indexer) STILL renders through the same
 * host <webview> as a plain webview view — the module just runs inside the
 * webview guest shell — so the layout probe is webview-centric for both.
 *
 * This spec drives the real plugin bundles inside the isolated Electron app via
 * Playwright (CDP under the hood), opens each panel in each mode, and dumps a
 * per-(mode,plugin) layout report: whether the plugin host chrome
 * (`plugin-page-back`) renders INLINE in the MAIN window, the <webview> +
 * content-region bounding boxes / computed styles, and clipping / zero-size /
 * horizontal-overflow diagnostics. The slash picker's rendered rows are dumped
 * too so a missing row is diagnosable rather than an opaque timeout.
 *
 * Inline proof (post-#1703): the plugin host chrome renders in the MAIN window
 * (page.evaluate only sees the main window's DOM, so finding plugin-page-back +
 * the webview there IS proof it did not detach). The old window-count / URL
 * heuristic is unreliable — a detached plugin window and the inline webview
 * guest BOTH load plugin-ui-shell.html — so it is not used for the assertion.
 *
 * Output: test/screenshots/out/layout-<mode>-<plugin>.json + one screenshot
 * per (mode, plugin). Run:
 *   bunx playwright test --config test/screenshots/playwright.config.ts \
 *     --grep "chat-mode plugin layout"
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect, REPO_ROOT } from "./fixtures.js";
import type { ElectronApplication, Page } from "playwright";

test.use({ installPlugins: ["meeting", "local-indexer"] });

const OUT_DIR = path.join(REPO_ROOT, "test/screenshots/out");
const PLUGINS = [
  { id: "meeting", label: "미팅" },
  { id: "local-indexer", label: "로컬 인덱서" },
] as const;
const MODES = ["work", "chat"] as const;

async function setMode(page: Page, mode: string): Promise<void> {
  const toggle = page.locator(`[data-testid="app-mode-${mode}"]`).first();
  if (await toggle.count()) {
    await toggle.click().catch(() => {});
  }
  await page.waitForTimeout(400);
}

/** Every rendered row's visible text in the (already-open) slash picker. */
async function dumpPickerRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[cmdk-item]")).map(
      (el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    ),
  );
}

interface OpenResult {
  pickerOpened: boolean;
  pickerRows: string[];
  rowFound: boolean;
  clicked: boolean;
}

/**
 * Open a plugin panel through the slash picker. Never throws on a missing row —
 * returns diagnostics (the rendered rows) so a plugin that fails to register /
 * stays in a preparing/doctor state is reported, not an opaque locator timeout.
 */
async function openPlugin(page: Page, label: string): Promise<OpenResult> {
  const out: OpenResult = { pickerOpened: false, pickerRows: [], rowFound: false, clicked: false };
  const composer = page.locator('[data-testid="composer-textarea"]').first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const picker = page.locator('[data-testid="slash-picker"]').first();
  try {
    await picker.waitFor({ state: "visible", timeout: 15_000 });
    out.pickerOpened = true;
  } catch {
    return out;
  }
  const cat = page.locator('[data-testid="slash-picker-cat-plugin"]').first();
  if (await cat.count()) {
    await cat.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  out.pickerRows = await dumpPickerRows(page);
  // Match the row anywhere in the picker list (not scoped to a single group —
  // an embedded-module or preparing entry may render in a different group box).
  const row = page.locator("[cmdk-item]").filter({ hasText: label }).first();
  try {
    await row.waitFor({ state: "visible", timeout: 8_000 });
    out.rowFound = true;
  } catch {
    return out;
  }
  await row.click();
  out.clicked = true;
  return out;
}

/**
 * A plugin panel fires several READ tools on mount (index_folders,
 * index_scan_status, index_documents, index_get_settings / meeting_list_preps);
 * the host classifies them write-category, so each raises an "Approve Tool
 * Execution" modal that covers the panel — they queue one after another. Approve
 * each (this-session scope; they are the panel's own empty-index reads, so this
 * is non-destructive) until none remains, so the panel loads its real empty
 * state for the capture instead of being covered by — or erroring under — a
 * modal. Returns the number of modals cleared.
 */
async function clearMountApprovalModals(page: Page): Promise<number> {
  const dialog = page.locator('[data-testid="tool-approval-dialog"]').first();
  let cleared = 0;
  for (let i = 0; i < 12; i++) {
    if (!(await dialog.count()) || !(await dialog.isVisible().catch(() => false))) break;
    const approve = dialog.locator('[data-testid="approve-button"]').first();
    if (await approve.count()) {
      await approve.click().catch(() => {});
    } else {
      break;
    }
    cleared++;
    await page.waitForTimeout(500); // let the next queued modal (if any) surface
  }
  return cleared;
}

/** Collect layout metrics from the renderer DOM (CDP-backed page.evaluate). */
async function collectLayout(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: cs.display,
        position: cs.position,
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        visibility: cs.visibility,
        opacity: cs.opacity,
        zIndex: cs.zIndex,
      };
    };
    const vw = { w: window.innerWidth, h: window.innerHeight };
    const webview = document.querySelector("webview");
    const back = document.querySelector('[data-testid="plugin-page-back"]');
    // The plugin host page shell is the closest ancestor of the back button
    // whose subtree also holds the plugin content (webview, when present).
    let shell: Element | null = back;
    while (shell && !shell.querySelector("webview")) shell = shell.parentElement;
    // Fallback: if no webview (error/placeholder content), the shell is the
    // page-shell ancestor of the back button that fills the pane.
    if (!shell && back) {
      let node: Element | null = back.parentElement;
      while (node && node.getBoundingClientRect().width < vw.w * 0.4) node = node.parentElement;
      shell = node;
    }
    const chatRoot = document.querySelector('[data-testid="chat-view-root"]');
    const webviewBox = box(webview);
    const shellBox = box(shell);
    // The content region under the back button carries whatever renders when
    // there is no webview (a doctor / entry-not-found / preparing placeholder),
    // so capture its text to make a webview-less panel diagnosable.
    let contentText: string | null = null;
    if (!webview && back) {
      const pane = back.closest('[data-testid="main-pane-shell"]') ?? back.parentElement;
      contentText = pane ? (pane as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 300) : null;
    }
    const within = (inner: { x: number; y: number; w: number; h: number } | null,
                    outer: { x: number; y: number; w: number; h: number } | null) =>
      inner && outer
        ? inner.x >= outer.x - 1 && inner.y >= outer.y - 1 &&
          inner.x + inner.w <= outer.x + outer.w + 1 &&
          inner.y + inner.h <= outer.y + outer.h + 1
        : null;
    return {
      viewport: vw,
      webview: webviewBox,
      pluginShell: shellBox,
      chatViewRoot: box(chatRoot),
      contentText,
      diagnostics: {
        webviewPresent: webview !== null,
        webviewZeroSize: webviewBox ? webviewBox.w === 0 || webviewBox.h === 0 : null,
        webviewWithinShell: within(webviewBox, shellBox),
        webviewWithinViewport: within(webviewBox, { x: 0, y: 0, w: vw.w, h: vw.h }),
        shellFillsWidth: shellBox ? Math.abs(shellBox.w) : null,
        bodyScrollW: document.body.scrollWidth,
        bodyClientW: document.body.clientWidth,
        horizontalOverflow: document.body.scrollWidth > document.body.clientWidth + 1,
      },
    };
  });
}

async function inspectOne(
  page: Page,
  app: ElectronApplication,
  mode: string,
  plugin: { id: string; label: string },
): Promise<Record<string, unknown>> {
  const urls = () =>
    app.windows().map((w) => {
      try {
        return w.url();
      } catch {
        return "?";
      }
    });
  await setMode(page, mode);
  const windowsBefore = app.windows().length;
  const urlsBefore = urls();
  const open = await openPlugin(page, plugin.label);

  // Inline render proof: the plugin host chrome renders in the MAIN window
  // (page.evaluate/this locator only see the main window's DOM).
  const back = page.locator('[data-testid="plugin-page-back"]').first();
  let inlineChromeVisible = false;
  try {
    await back.waitFor({ state: "visible", timeout: 20_000 });
    inlineChromeVisible = true;
  } catch {
    inlineChromeVisible = false;
  }
  const webview = page.locator("webview").first();
  let webviewAttached = false;
  try {
    await webview.waitFor({ state: "visible", timeout: 20_000 });
    webviewAttached = true;
  } catch {
    webviewAttached = false;
  }
  await page.waitForTimeout(1_800); // let the guest bundle settle
  // Approve the panel's mount-time read calls so the modals clear and the panel
  // loads its real empty state (layout metrics are read off the DOM either way).
  const approvalModalsCleared = await clearMountApprovalModals(page);
  await page.waitForTimeout(600); // let the panel repaint after the last approval

  const windowsAfter = app.windows().length;
  const urlsAfter = urls();
  const layout = await collectLayout(page);

  await page.screenshot({ path: path.join(OUT_DIR, `inspect-${mode}-${plugin.id}.png`) });

  return {
    mode,
    plugin: plugin.id,
    open,
    inline: {
      windowsBefore,
      windowsAfter,
      urlsBefore,
      urlsAfter,
      inlineChromeVisible, // MUST be true — plugin host renders in the main window
      webviewAttached,
      approvalModalsCleared,
    },
    layout,
  };
}

// One independent test per (mode, plugin) — each gets a FRESH Electron app from
// the fixture, so opening a single panel needs no reset-between-plugins dance
// (the prior source of flakiness). Each writes its own layout-<mode>-<plugin>.json
// BEFORE asserting, so the report is always available for analysis.
for (const mode of MODES) {
  for (const plugin of PLUGINS) {
    test(`chat-mode plugin layout — ${mode} / ${plugin.id}`, async ({
      mainWindow: page,
      app,
    }) => {
      test.setTimeout(120_000);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const r = await inspectOne(page, app, mode, plugin);
      fs.writeFileSync(
        path.join(OUT_DIR, `layout-${mode}-${plugin.id}.json`),
        JSON.stringify(r, null, 2),
      );
      const open = r.open as OpenResult;
      const inline = r.inline as { inlineChromeVisible: boolean };
      // local-indexer needs a provisioned Python runtime (boot.ts
      // PythonRuntimeBootstrapper injects `pythonExecutable`); that bootstrap
      // does not run in this isolated capture harness, so the plugin loads but
      // its startup throws and it degrades to a "… Doctor" picker entry instead
      // of the live "로컬 인덱서" panel — its live layout is not observable here.
      // This is orthogonal to the #1703 inline-routing change: every plugin view
      // shares one inline path (handleViewSelect `plugin:` branch → setActiveView,
      // no per-plugin detach branch), which the meeting panel exercises and
      // proves inline. Skip (don't fail) when that known degradation is detected;
      // the assertions below re-activate automatically if Python is ever
      // provisioned in the harness. The picker-row dump in the JSON records it.
      const degradedToDoctor =
        !open.rowFound && open.pickerRows.some((row) => /Doctor/i.test(row));
      test.skip(
        plugin.id === "local-indexer" && degradedToDoctor,
        "local-indexer cannot start without a provisioned Python runtime in the capture harness (degrades to a Doctor entry); its live panel layout is not observable here. Orthogonal to #1703.",
      );
      expect(open.rowFound, `${mode}/${plugin.id} slash-picker row not found; rows=${JSON.stringify(open.pickerRows)}`).toBe(true);
      expect(inline.inlineChromeVisible, `${mode}/${plugin.id} plugin host chrome not visible inline`).toBe(true);
    });
  }
}
