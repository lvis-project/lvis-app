/**
 * NSIS installer ↔ ASRT proxy-port-range drift guard.
 *
 * The Windows OS-sandbox backend (srt-win) is provisioned at APP-INSTALL time:
 * `build/installer.nsh`'s `customInstall` macro runs
 * `srt-win.exe install --proxy-port-range LO-HI`, which stamps a WFP filter
 * permitting exactly that loopback port range. At runtime the srt-win egress
 * proxy BINDS that same range (buildSandboxConfig → windows.proxyPortRange). If
 * the two desync, the proxy binds a port the WFP filter blocks and ALL sandboxed
 * egress hard-fails.
 *
 * Both runtime paths already converge on the local SOT constant
 * DEFAULT_WINDOWS_PROXY_PORT_RANGE (pinned to ASRT's real export by
 * asrt-sandbox.test.ts). This test closes the THIRD path — the installer literal
 * baked into installer.nsh, which is plain NSIS text no compiler checks — by
 * parsing the literal out of the .nsh and asserting it equals BOTH the host SOT
 * re-export AND ASRT's real exported constant. An ASRT update that changes the
 * range (or an installer edit that desyncs it) fails CI here instead of shipping
 * a silently-broken egress bind.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_WINDOWS_PROXY_PORT_RANGE } from "../asrt-sandbox.js";

// src/permissions/__tests__ → repo root is three levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALLER_NSH = join(REPO_ROOT, "build", "installer.nsh");

function extractInstallerProxyPortRange(): [number, number] {
  const nsh = readFileSync(INSTALLER_NSH, "utf8");
  // Match the ACTUAL command invocation, not the surrounding comments: an
  // `nsExec`/`ExecWait` line carrying `--proxy-port-range LO-HI`.
  const matches = [
    ...nsh.matchAll(/--proxy-port-range\s+(\d+)-(\d+)/g),
  ].filter((m) => {
    // Ignore occurrences inside comment lines (NSIS comments start with `;`).
    const lineStart = nsh.lastIndexOf("\n", m.index ?? 0) + 1;
    const line = nsh.slice(lineStart, nsh.indexOf("\n", m.index ?? 0));
    return !line.trimStart().startsWith(";");
  });
  expect(
    matches.length,
    "expected exactly one non-comment --proxy-port-range in build/installer.nsh",
  ).toBe(1);
  const [, lo, hi] = matches[0];
  return [Number(lo), Number(hi)];
}

describe("installer.nsh ↔ ASRT proxy-port-range drift guard", () => {
  it("installer.nsh --proxy-port-range equals the host SOT constant", () => {
    const installerRange = extractInstallerProxyPortRange();
    expect(installerRange).toEqual([
      DEFAULT_WINDOWS_PROXY_PORT_RANGE[0],
      DEFAULT_WINDOWS_PROXY_PORT_RANGE[1],
    ]);
  });

  it("installer.nsh --proxy-port-range equals ASRT's real exported constant", async () => {
    const installerRange = extractInstallerProxyPortRange();
    const asrt = await import("@anthropic-ai/sandbox-runtime");
    expect(installerRange).toEqual([
      asrt.DEFAULT_WINDOWS_PROXY_PORT_RANGE[0],
      asrt.DEFAULT_WINDOWS_PROXY_PORT_RANGE[1],
    ]);
  });
});
