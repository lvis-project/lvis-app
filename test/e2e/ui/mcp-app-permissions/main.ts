/**
 * Electron main for the MCP-App PERMISSIONS e2e.
 *
 * Same discipline as the handshake gate: every security-relevant piece is the REAL
 * production module, so this cannot pass against a reimplementation.
 *   - registerMcpAppProtocolScheme   (main/mcp-app-protocol.ts)
 *   - installMcpAppPartitionPolicy   (main/html-preview-partition.ts)
 *       → the declared-origin network gate, the `lvis-mcp-app://` handler that serves the
 *         proxy document (carrying the host-computed `allow` meta), the relay preload,
 *         AND the deny-by-default Electron permission handlers under test
 *   - createMcpAppProxySession       (main/mcp-app-protocol.ts)
 *
 * Two cards, ONE partition, ONE server — deliberately. Permissions are per-RESOURCE while
 * the Electron session is per-SERVER, so the interesting question is whether the host can
 * still tell them apart. It can: the decision is keyed off the proxy TOKEN, which main
 * minted together with that resource's declaration.
 *
 *   `declared` — resource declares all four spec features
 *   `absent`   — resource declares NOTHING (the fail-closed proof)
 *
 * The cards run SEQUENTIALLY, each in a shown and focused window. That is not incidental:
 * `navigator.clipboard.writeText` requires a focused document, and two simultaneous
 * webviews cannot both have focus — running them together made the unfocused card report
 * a bogus `NotAllowedError` that looked exactly like a permission denial. A harness that
 * cannot focus the card cannot measure the clipboard at all, and the probe says so
 * (`fail:UnfocusedHarness`) rather than pretending.
 *
 * Only the MCP server is stubbed (the HTML is handed in rather than fetched via
 * `resources/read`), exactly as the handshake gate does.
 */
import { app, BrowserWindow, protocol } from "electron";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMcpAppPartitionPolicy } from "../../../../src/main/html-preview-partition.js";
import {
  createMcpAppProxySession,
  disposeMcpAppProxySession,
  registerMcpAppProtocolScheme,
} from "../../../../src/main/mcp-app-protocol.js";
import { mcpAppPartitionName } from "../../../../src/shared/mcp-app-partition.js";
import type { McpUiResourcePermissions } from "../../../../src/mcp/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ID = "e2e-perm-server";

// All four spec features. Whether the host can HONOR them is what we are measuring —
// declaring them is the input, not the answer.
const ALL_FOUR: McpUiResourcePermissions = {
  clipboardWrite: {},
  camera: {},
  microphone: {},
  geolocation: {},
};

// A PARTIAL declaration: microphone only. camera and microphone collapse into Electron's
// single `media` permission, so the interesting fail-closed question is whether a card
// that declared ONLY the microphone can nonetheless open the CAMERA. It cannot: the
// host-computed `allow` attribute is `microphone` alone, so `getUserMedia({video})` is
// refused by Permissions Policy before Electron's `media` grant is ever consulted.
const MIC_ONLY: McpUiResourcePermissions = { microphone: {} };

registerMcpAppProtocolScheme(protocol);

// The two cards run in SEQUENCE, so there is a moment with no window open. Electron's
// default would quit the app right there and the second card would never run.
app.on("window-all-closed", () => {});

/** Resolves when a card reports `E2E_PROBE <label> DONE`. */
const doneWaiters = new Map<string, () => void>();

app.on("web-contents-created", (_e, contents) => {
  contents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined;
    const message =
      first && typeof first === "object" && "message" in first
        ? first.message
        : (args[2] as string | undefined);
    if (typeof message !== "string" || !message.startsWith("E2E_")) return;
    process.stdout.write(`${message}\n`);
    for (const [label, resolve] of doneWaiters) {
      if (message === `E2E_PROBE ${label} DONE`) {
        doneWaiters.delete(label);
        resolve();
      }
    }
  });
});

/**
 * The `allow` attribute that actually landed on the inner app frame, plus the meta main
 * served it in. DIRECT evidence that the host-computed allow-list reached the DOM —
 * separate from whether Chromium then honored it, which the probe measures.
 */
async function reportFrame(win: BrowserWindow, label: string): Promise<void> {
  const json = await win.webContents
    .executeJavaScript(
      `new Promise((res) => {
         const wv = document.querySelector("webview");
         wv.executeJavaScript(\`(() => {
           const f = document.querySelector("iframe");
           const m = document.querySelector('meta[name="lvis-mcp-app-allow"]');
           return JSON.stringify({
             allow: f ? f.getAttribute("allow") : null,
             sandbox: f ? f.getAttribute("sandbox") : null,
             meta: m ? m.getAttribute("content") : null,
           });
         })()\`).then(res, (e) => res(JSON.stringify({ error: String(e) })));
       })`,
    )
    .catch((err: unknown) => JSON.stringify({ error: String(err) }));
  process.stdout.write(`E2E_PROBE ${label} FRAME:${json}\n`);
}

/**
 * Run ONE card to completion in its own shown, focused window.
 *
 * `revokeToken` is the `revoked` case: once the proxy DOCUMENT has loaded (so the frame
 * already carries its host-computed `allow` attribute and the Permissions-Policy layer
 * will pass), drop the proxy session. From then on the ONLY thing that can deny the
 * feature is the Electron permission handler, which no longer finds a session for the
 * token. That is what isolates the handler — without it, this whole e2e would prove only
 * that the `allow` attribute works, and would stay green even if the handler were never
 * installed (Electron's DEFAULT is to grant).
 */
async function runCard(
  hostHtmlPath: string,
  card: { label: string; proxyUrl: string; html: string },
  revokeToken = false,
): Promise<void> {
  const win = new BrowserWindow({
    show: true,
    width: 500,
    height: 320,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const done = new Promise<void>((resolve) => doneWaiters.set(card.label, resolve));

  if (revokeToken) {
    const token = new URL(card.proxyUrl).searchParams.get("t") ?? "";
    win.webContents.on("did-attach-webview", (_e, guest) => {
      guest.on("did-finish-load", () => {
        if (!guest.getURL().startsWith("lvis-mcp-app:")) return;
        disposeMcpAppProxySession(token);
        process.stdout.write(`E2E_PROBE ${card.label} SESSION_REVOKED\n`);
      });
    });
  }

  win.webContents.on("did-finish-load", () => {
    win.show();
    win.focus();
    void win.webContents.executeJavaScript(
      `window.__startProbe(${JSON.stringify({
        serverId: SERVER_ID,
        partition: mcpAppPartitionName(SERVER_ID),
        card,
      })})`,
    );
  });

  await win.loadFile(hostHtmlPath);
  await done;
  await reportFrame(win, card.label);
  win.destroy();
}

app.whenReady().then(async () => {
  // The REAL per-server policy: network gate + protocol handler + relay preload + the
  // deny-by-default permission handlers.
  installMcpAppPartitionPolicy(SERVER_ID);


  const declaredUrl = createMcpAppProxySession(SERVER_ID, undefined, ALL_FOUR);
  const absentUrl = createMcpAppProxySession(SERVER_ID, undefined, undefined);
  // Declares the same four; its session is revoked once the frame is up (see `runCard`).
  const revokedUrl = createMcpAppProxySession(SERVER_ID, undefined, ALL_FOUR);
  // Declares microphone ONLY — the per-feature fail-closed proof for the media collision.
  const micOnlyUrl = createMcpAppProxySession(SERVER_ID, undefined, MIC_ONLY);

  const probeJs = readFileSync(join(HERE, "mcp-app-permissions-probe.js"), "utf-8");
  // The two cards are byte-identical apart from the case label, so any difference in
  // outcome is attributable to the DECLARATION alone.
  const cardHtml = (label: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<script>window.__CASE=${JSON.stringify(label)};</script>` +
    `<script>${probeJs}</script></body></html>`;

  const hostJs = readFileSync(join(HERE, "mcp-app-permissions-host.js"), "utf-8");
  const dir = mkdtempSync(join(tmpdir(), "lvis-mcp-app-perm-e2e-"));
  const hostHtmlPath = join(dir, "host.html");
  writeFileSync(
    hostHtmlPath,
    `<!doctype html><html><body><script>${hostJs}</script></body></html>`,
    "utf-8",
  );

  await runCard(hostHtmlPath, {
    label: "declared",
    proxyUrl: declaredUrl,
    html: cardHtml("declared"),
  });
  await runCard(hostHtmlPath, { label: "absent", proxyUrl: absentUrl, html: cardHtml("absent") });
  await runCard(
    hostHtmlPath,
    { label: "revoked", proxyUrl: revokedUrl, html: cardHtml("revoked") },
    true,
  );
  await runCard(hostHtmlPath, {
    label: "mic-only",
    proxyUrl: micOnlyUrl,
    html: cardHtml("mic-only"),
  });

  process.stdout.write("E2E_PROBE ALL_DONE\n");
});
