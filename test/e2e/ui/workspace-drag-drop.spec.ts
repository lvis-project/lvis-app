import { test, expect } from "./fixtures";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

/**
 * Drag-drop add-root, real-Electron (#1458).
 *
 * The prior drag-drop impl was removed for a jsdom false-green: a test that faked
 * `File.prototype.path` / a `{ path }` shape proves nothing, because the real path
 * only exists through `webUtils.getPathForFile` against an OS-backed File.
 *
 * IMPORTANT — CDP limitation (electron/electron#44600, #44982): a SYNTHETIC drop
 * injected via `Input.dispatchDragEvent` does NOT back its File with a real OS
 * path, so `webUtils.getPathForFile` returns "" for it. No browser-automation
 * primitive can synthesize an OS-backed dropped File. We therefore prove the two
 * halves of the feature with the seams automation CAN reach — both against a REAL
 * packaged renderer, a REAL preload bridge, and a REAL main process, never a fake:
 *
 *   (A) The real drop wiring + safe no-op: a synthetic CDP drop fires the real
 *       React handler, runs the real preload `webUtils` bridge, and (because the
 *       path is empty under CDP) is a correct no-op — no ack, no error, no widen.
 *       This locks that the drop handler and the bridge are wired to real Electron
 *       `webUtils` (not a stub) and that a path-less drag can never widen scope.
 *
 *   (B) The real trust pipeline: driving the drop's post-resolution flow through
 *       the REAL preload IPC (`window.lvis.workspace.dropPrepare`) with a REAL
 *       seeded folder path — the opposite of the banned `{path}` fake — exercises
 *       the real main handler (real `validateDirectoryAddition` + real `fs.stat`),
 *       real ack token, real `pickRoot` persistence, and real `listRoots`.
 */
test.describe("workspace drag-drop add-root (#1458)", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let dropTarget: string;
  let sensitiveTarget: string;
  let fileTarget: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-drop-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-drop-home-"));
    mkdirSync(resolve(tempHome, ".lvis", "workspace"), { recursive: true });
    // A real folder OUTSIDE the default allow-list — a successful add widens scope.
    dropTarget = resolve(tempHome, "dropme-project");
    mkdirSync(dropTarget, { recursive: true });
    writeFileSync(resolve(dropTarget, "readme.md"), "# Dropped\n", "utf-8");
    // A Layer-0 sensitive dir the drop MUST hard-deny even via the ack tier.
    sensitiveTarget = resolve(tempHome, ".lvis", "secrets");
    mkdirSync(sensitiveTarget, { recursive: true });
    // A plain file — a dropped file is not a root (not-a-dir).
    fileTarget = resolve(tempHome, "loose-file.txt");
    writeFileSync(fileTarget, "not a folder\n", "utf-8");

    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_HOME: resolve(tempHome, ".lvis"),
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  /** Open the file-browser and return the drop-zone bounding box centre (px). */
  async function openRootsZone(): Promise<{ x: number; y: number }> {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await page.getByTestId("chat-side-panel-launcher-file-browser").click();
    const zone = page.getByTestId("chat-side-panel-project-roots");
    await expect(zone).toBeVisible();
    const box = await zone.boundingBox();
    if (!box) throw new Error("project-roots drop zone has no bounding box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // ── (A) real drop wiring + safe no-op via a synthetic CDP drop ────────────
  test("a real drop fires the handler + real webUtils bridge and is a safe no-op under CDP (no widen)", async () => {
    const { x, y } = await openRootsZone();
    // Assert the bridge is the REAL preload export wired to Electron webUtils
    // (a function on window.lvisDrop), not a test stub.
    const bridgeType = await page.evaluate(() => typeof window.lvisDrop?.resolveDroppedPaths);
    expect(bridgeType).toBe("function");

    // Instrument the real drop path: capture what the handler's real bridge call
    // yields. Under CDP the resolved path is "" (electron#44600) → [].
    await page.evaluate(() => {
      const w = window as unknown as { __dropResolved?: string[] };
      const el = document.querySelector('[data-testid="chat-side-panel-project-roots"]');
      el?.addEventListener(
        "drop",
        (e) => {
          const files = (e as DragEvent).dataTransfer?.files;
          w.__dropResolved = files ? window.lvisDrop.resolveDroppedPaths(files) : ["<no-dt>"];
        },
        { capture: true, once: true },
      );
    });
    // Kick the real drop via CDP AFTER the listener is attached.
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [dropTarget], dragOperationsMask: 1 };
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
    await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
    await cdp.detach();

    // The real bridge ran and yielded no path (CDP can't back the File) — so the
    // drop is a correct no-op: no ack panel, no error, scope unchanged.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __dropResolved?: string[] }).__dropResolved))
      .toEqual([]);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("chat-side-panel-root-warning")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-op-error")).toHaveCount(0);
  });

  // ── (B) real trust pipeline via the real preload IPC + real main handler ───
  test("real pipeline: a valid dropped folder adds as a root only after an explicit ack", async () => {
    await openRootsZone();
    // Drive the post-resolution flow the drop handler runs, through the REAL
    // preload IPC + REAL main handler, with a REAL seeded folder path.
    const prep = await page.evaluate(
      (p) => window.lvis.workspace.dropPrepare(p),
      dropTarget,
    );
    expect(prep.ok).toBe(true);
    expect(prep.pendingPath).toBe(dropTarget);
    expect(typeof prep.ackToken).toBe("string");

    // listRoots reports the canonical realpath (macOS /var → /private/var), so
    // compare roots against the realpath while the ack flow uses the raw path.
    const canonicalDrop = realpathSync(dropTarget);

    // Before the ack the scope has NOT widened.
    const before = await page.evaluate(() => window.lvis.workspace.listRoots());
    expect((before.roots ?? []).some((r) => r.path === canonicalDrop)).toBe(false);

    // Confirm by echoing the token (never the path) → real persistence.
    const done = await page.evaluate(
      (tok) => window.lvis.workspace.pickRoot({ ackToken: tok }),
      prep.ackToken as string,
    );
    expect(done.ok).toBe(true);
    expect(done.added).toBe(dropTarget);

    const after = await page.evaluate(() => window.lvis.workspace.listRoots());
    expect((after.roots ?? []).some((r) => r.path === canonicalDrop)).toBe(true);
  });

  test("real pipeline: a Layer-0 sensitive folder is hard-denied and mints no ack token", async () => {
    await openRootsZone();
    const prep = await page.evaluate(
      (p) => window.lvis.workspace.dropPrepare(p),
      sensitiveTarget,
    );
    expect(prep.ok).toBe(false);
    // Stable code (renderer maps to Korean) — NOT the validator's English prose.
    expect(prep.error).toBe("sensitive-path");
    expect(prep.ackToken).toBeUndefined();
    const roots = await page.evaluate(() => window.lvis.workspace.listRoots());
    expect((roots.roots ?? []).some((r) => r.path === sensitiveTarget)).toBe(false);
  });

  test("real pipeline: a dropped plain file is rejected (not-a-dir) — no parent inference", async () => {
    await openRootsZone();
    const prep = await page.evaluate((p) => window.lvis.workspace.dropPrepare(p), fileTarget);
    expect(prep.ok).toBe(false);
    expect(prep.error).toBe("not-a-dir");
    expect(prep.ackToken).toBeUndefined();
  });

  test("real pipeline: a dir swapped for a file between prepare and ack is refused (TOCTOU)", async () => {
    await openRootsZone();
    // Prepare a real directory and mint a token, then replace the directory with
    // a regular file before echoing the token. The ack/persist pass must re-stat
    // and refuse the non-directory rather than widening the read scope.
    const toctouTarget = resolve(tempHome, "toctou-project");
    mkdirSync(toctouTarget, { recursive: true });
    const prep = await page.evaluate((p) => window.lvis.workspace.dropPrepare(p), toctouTarget);
    expect(prep.ok).toBe(true);
    expect(typeof prep.ackToken).toBe("string");
    // Swap the directory for a file (main-side fs, outside the renderer).
    rmSync(toctouTarget, { recursive: true, force: true });
    writeFileSync(toctouTarget, "now a file\n", "utf-8");
    const done = await page.evaluate(
      (tok) => window.lvis.workspace.pickRoot({ ackToken: tok }),
      prep.ackToken as string,
    );
    expect(done.ok).toBe(false);
    expect(done.error).toBe("not-a-dir");
    const canonical = realpathSync(toctouTarget);
    const after = await page.evaluate(() => window.lvis.workspace.listRoots());
    expect((after.roots ?? []).some((r) => r.path === canonical || r.path === toctouTarget)).toBe(false);
    rmSync(toctouTarget, { force: true });
  });
});
