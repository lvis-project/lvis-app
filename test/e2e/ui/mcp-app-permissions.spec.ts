/**
 * THE GATE for MCP-App per-resource `permissions`.
 *
 * The spec (`2026-01-26`, apps.mdx:474-475) MUSTs that the Sandbox and Host have DIFFERENT
 * origins and that the Sandbox carry `allow-scripts` AND `allow-same-origin`. This host now
 * satisfies both: the inner app frame is `<iframe sandbox="allow-scripts allow-same-origin"
 * srcdoc>`, so it inherits the per-server proxy origin (`lvis-mcp-app://<hex>`) — a real,
 * NON-opaque origin — instead of running opaque. That origin change is what makes the
 * spec's `permissions` (camera / microphone / geolocation / clipboardWrite) able to work.
 *
 * This test RUNS all four, for real, inside a real Electron <webview> on the real
 * production path, and records what each one does. Why it has to RUN them: whether Chromium
 * delivers a given powerful feature to this frame is not decidable by reading code, and a
 * schema field for a feature that silently does nothing is precisely the bug this change
 * exists to prevent. So the MEASUREMENT decides what ships, and this file is that
 * measurement.
 *
 * ─── WHAT IT MEASURED (Electron 43 / Chromium; Windows) ──────────────────────────────
 *   camera          WORKS.  declared ⇒ getUserMedia({video}) is not permission-denied;
 *                           undeclared ⇒ NotAllowedError. (Was `SecurityError: Invalid
 *                           security origin` under the old OPAQUE origin — the origin
 *                           change is exactly what fixed it.)
 *   microphone      WORKS.  same, for getUserMedia({audio}).
 *   geolocation     WORKS.  declared ⇒ getCurrentPosition is not permission-denied (code 1);
 *                           undeclared ⇒ code 1.
 *   clipboardWrite  DOES NOT. declared or not, navigator.clipboard.writeText → NotAllowedError:
 *                           Write permission denied. A script-initiated async clipboard write
 *                           with no transient user activation is refused regardless of origin
 *                           or Permissions Policy. Hence it is NOT in MCP_APP_PERMISSION_FEATURES
 *                           and NOT in the manifest schema (declaring it fails validation loudly).
 *
 * ─── The four cards ──────────────────────────────────────────────────────────────────
 *   declared — declares all four. Measures what the host can actually deliver, and proves the
 *              host-computed allow-list is the host CAPABILITY set (camera; microphone;
 *              geolocation) — NOT a copy of the declaration (which also asked for clipboard).
 *   absent   — declares NOTHING. Fail-closed proof at the POLICY layer: no `allow` attribute,
 *              every feature denied.
 *   revoked  — declares all four, but the proxy session is dropped once the frame is up. The
 *              `allow` attribute is therefore already in place and Permissions-Policy passes, so
 *              the ONLY thing left that can deny is the ELECTRON permission handler. Without this
 *              case the suite would stay green even if the handler were never installed (Electron
 *              defaults to GRANT).
 *   mic-only — declares microphone ONLY. camera and microphone collapse into Electron's single
 *              `media` permission; this card proves a mic-only card canNOT open the camera. It is
 *              the direct evidence that the media-KIND check in the Electron handler — not the
 *              `allow` attribute, which does NOT gate camera vs microphone for a same-origin
 *              frame (measured) — is what enforces the split.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const OUT_DIR = path.join(REPO_ROOT, "dist/src/main");
const MAIN_OUT = path.join(OUT_DIR, "mcp-app-permissions-main.js");

test.beforeAll(async () => {
  const preload = path.join(REPO_ROOT, "dist/src/mcp-app-preload.cjs");
  if (!fs.existsSync(preload)) {
    throw new Error(`Relay preload not built at ${preload}. Run 'bun run build' first.`);
  }

  for (const [entry, outfile] of [
    ["host.ts", path.join(OUT_DIR, "mcp-app-permissions-host.js")],
    ["probe-app.ts", path.join(OUT_DIR, "mcp-app-permissions-probe.js")],
  ] as const) {
    await build({
      entryPoints: [path.join(HERE, "mcp-app-permissions", entry)],
      outfile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
  }

  await build({
    entryPoints: [path.join(HERE, "mcp-app-permissions/main.ts")],
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

// Four cards run in sequence, each with a bounded geolocation probe.
test.setTimeout(180_000);

test("MCP-App permissions: what the host can actually deliver, measured in a real <webview>", async () => {
  const app = await electron.launch({ args: [MAIN_OUT, "--no-sandbox"], timeout: 30_000 });

  const lines: string[] = [];
  app.process().stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim().startsWith("E2E_")) lines.push(line.trim());
    }
  });

  /** The recorded outcome for one feature on one card: `ok` or `fail:<Name>|<message>`. */
  const outcome = (label: string, feature: string): string => {
    const prefix = `E2E_PROBE ${label} ${feature}:`;
    return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? "<no-result>";
  };
  const frame = (label: string): { allow: string | null; sandbox: string | null; meta: string | null } => {
    const prefix = `E2E_PROBE ${label} FRAME:`;
    const line = lines.find((l) => l.startsWith(prefix));
    if (!line) throw new Error(`no FRAME line for ${label}`);
    return JSON.parse(line.slice(prefix.length));
  };

  // A getUserMedia result is a DENIAL iff it is a NotAllowedError. A granted permission on
  // a machine with no webcam/mic yields NotFoundError (or NotReadableError) instead — still
  // "granted", just no hardware — so keying on NotAllowedError keeps the test CI-portable.
  const mediaGranted = (o: string): boolean => o === "ok" || !/NotAllowedError/.test(o);
  const mediaDenied = (o: string): boolean => /NotAllowedError/.test(o);
  // A geolocation DENIAL is code=1 (PERMISSION_DENIED). A grant that cannot fix a position on
  // a provider-less box is code=2 (POSITION_UNAVAILABLE) — "granted", so not a denial.
  const geoGranted = (o: string): boolean => o === "ok" || (!/code=1/.test(o) && !/permissions policy/i.test(o));
  const geoDenied = (o: string): boolean => /code=1/.test(o);

  try {
    await expect
      .poll(() => lines.includes("E2E_PROBE ALL_DONE"), { timeout: 150_000, intervals: [200] })
      .toBe(true);

    // The evidence, readable without re-running anything.
    console.log(`\n─── MCP-App permissions, measured ───`);
    for (const feature of ["camera", "microphone", "geolocation", "clipboardWrite"] as const) {
      console.log(
        `  ${feature.padEnd(15)} declared=${outcome("declared", feature)}\n` +
          `  ${" ".repeat(15)} absent  =${outcome("absent", feature)}\n` +
          `  ${" ".repeat(15)} mic-only=${outcome("mic-only", feature)}`,
      );
    }

    // ── The inner frame is NON-opaque now — the whole origin-model change. ─────────────
    // Every card's inner srcdoc frame reports a real origin (window.origin !== "null"),
    // and carries the spec-required sandbox pair.
    for (const label of ["declared", "absent", "revoked", "mic-only"]) {
      expect(lines).toContain(`E2E_PROBE ${label} OPAQUE_ORIGIN:false`);
      expect(frame(label).sandbox).toBe("allow-scripts allow-same-origin");
    }

    // ── The host-computed allow-list reached the frame — and ONLY the host CAPABILITY set ──
    // The declared card asked for ALL FOUR, yet the frame is delegated `camera; microphone;
    // geolocation` — NOT clipboard-write. The allow-list is computed from the host's table,
    // not copied from the declaration. Absent ⇒ no meta, no `allow` attribute at all.
    expect(frame("declared").allow).toBe("camera; microphone; geolocation");
    expect(frame("declared").meta).toBe("camera; microphone; geolocation");
    expect(frame("absent").allow).toBeNull();
    expect(frame("absent").meta).toBeNull();
    // mic-only is delegated exactly `microphone`.
    expect(frame("mic-only").allow).toBe("microphone");
    expect(frame("mic-only").meta).toBe("microphone");

    // ── camera / microphone / geolocation: DECLARED ⇒ delivered ───────────────────────
    expect(mediaGranted(outcome("declared", "camera"))).toBe(true);
    expect(mediaGranted(outcome("declared", "microphone"))).toBe(true);
    expect(geoGranted(outcome("declared", "geolocation"))).toBe(true);

    // ── FAIL-CLOSED #1 (policy layer): undeclared ⇒ nothing ──────────────────────────
    // Identical HTML, same partition, same Electron session. Only the DECLARATION differs.
    expect(mediaDenied(outcome("absent", "camera"))).toBe(true);
    expect(mediaDenied(outcome("absent", "microphone"))).toBe(true);
    expect(geoDenied(outcome("absent", "geolocation"))).toBe(true);

    // ── FAIL-CLOSED #2 (Electron layer): the handler is installed and it DENIES ───────
    // This card DID declare, so its frame carries the `allow` attribute and Permissions-
    // Policy passes — the failure below cannot come from that layer. Its proxy session was
    // revoked, so `isMcpAppPermissionGranted` finds no session and denies. If
    // `installMcpAppPartitionPolicy` ever stopped installing the permission handlers,
    // Electron's default would GRANT and these assertions turn red.
    expect(lines).toContain("E2E_PROBE revoked SESSION_REVOKED");
    expect(frame("revoked").allow).toBe("camera; microphone; geolocation");
    expect(mediaDenied(outcome("revoked", "camera"))).toBe(true);
    expect(mediaDenied(outcome("revoked", "microphone"))).toBe(true);
    expect(geoDenied(outcome("revoked", "geolocation"))).toBe(true);

    // ── FAIL-CLOSED #3 (media-kind split): mic-only canNOT open the camera ────────────
    // camera and microphone are one Electron `media` permission. A card that declared ONLY
    // the microphone gets its mic — and is DENIED the camera. Measured necessity: the `allow`
    // attribute does NOT enforce this for a same-origin frame (a mic-only card WAS able to
    // open the camera until the handler matched on media kind), so this is the live guard for
    // the collision. If the kind check regresses, this camera assertion turns red.
    expect(mediaGranted(outcome("mic-only", "microphone"))).toBe(true);
    expect(mediaDenied(outcome("mic-only", "camera"))).toBe(true);
    // mic-only never declared geolocation ⇒ denied.
    expect(geoDenied(outcome("mic-only", "geolocation"))).toBe(true);

    // ── clipboardWrite: NOT AVAILABLE — never granted on any card ─────────────────────
    // Excluded from the capability table (measured: denied even when delegated), so the
    // declared card's `allow` never carried it and every card is refused.
    for (const label of ["declared", "absent", "revoked", "mic-only"] as const) {
      expect(outcome(label, "clipboardWrite")).toMatch(/^fail:/);
    }

    expect(lines.join("\n")).not.toContain("BRIDGE_CONNECT_FAILED");
  } finally {
    console.log(`\n─── raw markers ───\n${lines.join("\n")}\n`);
    await app.close().catch(() => {});
  }
});
