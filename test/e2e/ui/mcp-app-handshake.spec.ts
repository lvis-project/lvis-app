/**
 * THE GATE for the ext-apps transport adoption.
 *
 * A real Electron <webview> must complete `ui/initialize` end-to-end with an
 * UNMODIFIED ext-apps `App` — no self-echo, response received, and the host's
 * AppBridge observing `ui/notifications/initialized`.
 *
 * Why this is an ELECTRON spec and not a Chromium <iframe> harness: in a plain
 * Chromium iframe `window.parent` crosses, so a bare-iframe test passes even when
 * the webview path is completely dead. That is exactly how the old hand-rolled
 * bridge shipped broken (its unit tests called the handler directly, and its e2e
 * used an <iframe>). Only a real <webview> can prove this.
 *
 * Everything under the transport is production code — the privileged scheme, the
 * sandbox-proxy document + CSP response header, the relay preload installed via
 * session.setPreloads(), and the inner sandboxed iframe.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
// Bundled INTO dist/src/main/ so the production preload resolution
// (`resolve(__dirname, "..", "mcp-app-preload.cjs")`) lands on the real preload.
const OUT_DIR = path.join(REPO_ROOT, "dist/src/main");
const MAIN_OUT = path.join(OUT_DIR, "mcp-app-handshake-main.js");

test.beforeAll(async () => {
  const preload = path.join(REPO_ROOT, "dist/src/mcp-app-preload.cjs");
  if (!fs.existsSync(preload)) {
    throw new Error(`Relay preload not built at ${preload}. Run 'bun run build' first.`);
  }

  // The two page scripts are bundled to plain IIFEs and inlined into documents by
  // the test main; the main itself is an ESM bundle alongside the real main.js.
  for (const [entry, outfile] of [
    ["host.ts", path.join(OUT_DIR, "mcp-app-handshake-host.js")],
    ["inner-app.ts", path.join(OUT_DIR, "mcp-app-handshake-inner.js")],
  ] as const) {
    await build({
      entryPoints: [path.join(HERE, "mcp-app-handshake", entry)],
      outfile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
  }

  await build({
    entryPoints: [path.join(HERE, "mcp-app-handshake/main.ts")],
    outfile: MAIN_OUT,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["electron"],
    banner: {
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
    logLevel: "silent",
  });
});

test("real <webview> completes ui/initialize with an UNMODIFIED ext-apps App", async () => {
  const app = await electron.launch({
    args: [MAIN_OUT, "--no-sandbox"],
    timeout: 30_000,
  });

  const lines: string[] = [];
  app.process().stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("E2E_")) lines.push(line.trim());
    }
  });
  app.process().stderr?.on("data", (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));

  const waitFor = async (marker: string): Promise<void> => {
    await expect
      .poll(() => lines.some((l) => l.includes(marker)), { timeout: 30_000, intervals: [100] })
      .toBe(true);
  };

  try {
    // 1. The relay preload loaded in the sandbox-proxy document and announced itself.
    //    (Proves session.setPreloads() actually injected a preload into the webview.)
    await waitFor("SANDBOX_READY");

    // 2. The inner frame is NOT its own parent — the self-echo is gone. This is the
    //    single fact the old <webview>-hosted bridge could never satisfy.
    await waitFor("PARENT_IS_SELF:false");

    // 3. THE GATE: the host AppBridge saw `ui/notifications/initialized`, so the
    //    unmodified App's initialize request crossed out of the guest, was answered,
    //    and the App accepted the response.
    await waitFor("HANDSHAKE_OK");
    await waitFor("INNER_CONNECTED");

    expect(lines.join("\n")).not.toContain("INNER_CONNECT_FAILED");
    expect(lines.join("\n")).not.toContain("BRIDGE_CONNECT_FAILED");
    expect(lines.some((l) => l.includes("PARENT_IS_SELF:true"))).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});
