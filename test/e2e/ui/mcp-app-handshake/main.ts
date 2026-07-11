/**
 * Electron main for the MCP-App handshake e2e.
 *
 * Deliberately thin: every security-relevant piece below is the REAL production
 * module, so this test cannot pass against a reimplementation.
 *   - registerMcpAppProtocolScheme      (main/mcp-app-protocol.ts)
 *   - installMcpAppPartitionPolicy      (main/html-preview-partition.ts)
 *       → installs the CDN gate, the `lvis-mcp-app://` protocol handler that
 *         serves the sandbox-proxy document with its CSP response header, and
 *         the relay preload via session.setPreloads()
 *   - createMcpAppProxySession          (main/mcp-app-protocol.ts)
 *
 * Only the MCP server is stubbed: we hand the app HTML in directly instead of
 * doing a `resources/read`. Everything from the transport down is production.
 *
 * This is bundled INTO `dist/src/main/` so that `__dirname`-relative preload
 * resolution (`../mcp-app-preload.cjs`) lands on the real built preload, exactly
 * as it does in production.
 */
import { app, BrowserWindow, protocol } from "electron";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMcpAppPartitionPolicy } from "../../../../src/main/html-preview-partition.js";
import {
  createMcpAppProxySession,
  registerMcpAppProtocolScheme,
} from "../../../../src/main/mcp-app-protocol.js";
import { mcpAppPartitionName } from "../../../../src/shared/mcp-app-partition.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ID = "e2e-mcp-server";

// Must run before app.ready — same as production (early-boot-env.ts).
registerMcpAppProtocolScheme(protocol);

// Surface every renderer/webview console line so the spec can assert on the
// handshake markers emitted by host.ts and inner-app.ts.
app.on("web-contents-created", (_e, contents) => {
  contents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined;
    const message =
      first && typeof first === "object" && "message" in first
        ? first.message
        : (args[2] as string | undefined);
    if (typeof message === "string" && message.startsWith("E2E_")) {
      process.stdout.write(`${message}\n`);
    }
  });
});

app.whenReady().then(() => {
  // Real production path: CDN gate + protocol handler + relay preload.
  installMcpAppPartitionPolicy(SERVER_ID);
  const proxyUrl = createMcpAppProxySession(SERVER_ID);

  // The "app HTML" an MCP server would have returned from resources/read. It is
  // a stock ext-apps App (see inner-app.ts) — no LVIS code, no shim.
  const innerJs = readFileSync(join(HERE, "mcp-app-handshake-inner.js"), "utf-8");
  const innerHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${innerJs}</script></body></html>`;

  const hostJs = readFileSync(join(HERE, "mcp-app-handshake-host.js"), "utf-8");
  const dir = mkdtempSync(join(tmpdir(), "lvis-mcp-app-e2e-"));
  const hostHtmlPath = join(dir, "host.html");
  writeFileSync(hostHtmlPath, `<!doctype html><html><body><script>${hostJs}</script></body></html>`, "utf-8");

  const win = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(
      `window.__startHandshake(${JSON.stringify({
        proxyUrl,
        partition: mcpAppPartitionName(SERVER_ID),
        html: innerHtml,
      })})`,
    );
  });

  void win.loadFile(hostHtmlPath);
});
