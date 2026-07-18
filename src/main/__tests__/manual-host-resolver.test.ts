/**
 * Manual host-resolver tests.
 *
 * Two layers:
 *  1. `parseHostResolverMap` (shared parser) — line parsing + validation.
 *  2. `applyManualHostResolverRules` read-back integration — the writer
 *     (`SettingsService`) and reader (this module) MUST agree on the settings
 *     file path. This is the regression guard for the CRITICAL bug where the
 *     reader hardcoded `~/.lvis/lvis-settings.json` while the writer persisted
 *     to `<userData>/lvis-settings.json`: a saved map never reached the reader,
 *     so the switch was never installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { parseHostResolverMap } from "../../shared/host-resolver-map.js";
import { applyManualHostResolverRules } from "../manual-host-resolver.js";
import { SettingsService } from "../../data/settings-store.js";

describe("parseHostResolverMap", () => {
  it("parses a single valid entry", () => {
    expect(parseHostResolverMap("10.182.192.174 host.example.com")).toEqual([
      { hostname: "host.example.com", ip: "10.182.192.174" },
    ]);
  });

  it("parses multiple entries", () => {
    const raw = `10.1.2.3 api.example.com
10.4.5.6 cdn.example.com`;
    expect(parseHostResolverMap(raw)).toEqual([
      { hostname: "api.example.com", ip: "10.1.2.3" },
      { hostname: "cdn.example.com", ip: "10.4.5.6" },
    ]);
  });

  it("skips blank lines", () => {
    const raw = `10.1.2.3 api.example.com

10.4.5.6 cdn.example.com`;
    expect(parseHostResolverMap(raw)).toHaveLength(2);
  });

  it("skips comment lines starting with #", () => {
    const raw = `# this is a comment
10.1.2.3 api.example.com
# another comment`;
    expect(parseHostResolverMap(raw)).toEqual([
      { hostname: "api.example.com", ip: "10.1.2.3" },
    ]);
  });

  it("skips malformed entries with no whitespace separator", () => {
    const raw = `notanentry
10.1.2.3 valid.example.com`;
    expect(parseHostResolverMap(raw)).toEqual([
      { hostname: "valid.example.com", ip: "10.1.2.3" },
    ]);
  });

  it("normalizes hostname to lowercase", () => {
    expect(parseHostResolverMap("10.1.2.3 HOST.EXAMPLE.COM")).toEqual([
      { hostname: "host.example.com", ip: "10.1.2.3" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseHostResolverMap("")).toEqual([]);
  });

  it("returns empty array for all-comment input", () => {
    expect(parseHostResolverMap("# one\n# two")).toEqual([]);
  });

  it("handles /etc/hosts-style tabs as whitespace separators", () => {
    expect(parseHostResolverMap("10.1.2.3\tapi.example.com")).toEqual([
      { hostname: "api.example.com", ip: "10.1.2.3" },
    ]);
  });

  // ── Validation (extra-MAP-rule injection guard) ──────────────────────────
  it("rejects an IPv4 octet above 255", () => {
    expect(parseHostResolverMap("10.1.2.300 host.example.com")).toEqual([]);
  });

  it("rejects a non-canonical IPv4 with leading zeros", () => {
    expect(parseHostResolverMap("010.1.2.3 host.example.com")).toEqual([]);
  });

  it("rejects a non-dotted-quad IP", () => {
    expect(parseHostResolverMap("10.1.2 host.example.com")).toEqual([]);
  });

  it("rejects a hostname with a comma (extra MAP rule injection)", () => {
    // A naive parser splitting only on whitespace would carry a comma through
    // into the switch, smuggling a second `MAP` rule. The two-token + DNS
    // charset checks reject it.
    expect(parseHostResolverMap("10.1.2.3 host.example.com,evil.example.com")).toEqual([]);
  });

  it("rejects a line with a trailing extra token", () => {
    expect(parseHostResolverMap("10.1.2.3 host.example.com extra")).toEqual([]);
  });

  it("rejects a hostname with non-DNS characters", () => {
    expect(parseHostResolverMap("10.1.2.3 host_under!score")).toEqual([]);
  });

  it("rejects a bare dot and empty labels (RFC 1123)", () => {
    expect(parseHostResolverMap("10.1.2.3 .")).toEqual([]);
    expect(parseHostResolverMap("10.1.2.3 a..b")).toEqual([]);
  });

  it("rejects labels starting or ending with a hyphen (RFC 1123)", () => {
    expect(parseHostResolverMap("10.1.2.3 -host.example.com")).toEqual([]);
    expect(parseHostResolverMap("10.1.2.3 host-.example.com")).toEqual([]);
  });

  it("accepts a hyphenated label that does not start/end with a hyphen", () => {
    expect(parseHostResolverMap("10.1.2.3 my-host.example.com")).toEqual([
      { hostname: "my-host.example.com", ip: "10.1.2.3" },
    ]);
  });

  it("accepts a public endpoint (manual mode is intentionally unrestricted)", () => {
    // Manual mode is a power-user surface — no RFC1918 confinement. A public
    // IP/hostname pair is a valid mapping.
    expect(parseHostResolverMap("203.0.113.10 public.example.com")).toEqual([
      { hostname: "public.example.com", ip: "203.0.113.10" },
    ]);
  });
});

describe("applyManualHostResolverRules — writer/reader path read-back", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "manual-host-resolver-"));
  });

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
  });

  /** Minimal `app.commandLine` double capturing the applied switch. */
  function makeCommandLineSpy() {
    const calls: Array<{ name: string; value: string }> = [];
    return {
      app: {
        commandLine: {
          appendSwitch: (name: string, value?: string) => {
            calls.push({ name, value: value ?? "" });
          },
        },
      } as Parameters<typeof applyManualHostResolverRules>[0],
      calls,
    };
  }

  it("reads back the exact map a SettingsService persisted (CRITICAL path unity)", async () => {
    // Writer: persist a manual-mode host map via the real SettingsService.
    const service = new SettingsService({ userDataPath });
    await service.patch({
      llm: {
        hostResolverMap: "10.0.0.10 endpoint.example.com\n10.0.0.11 cdn.example.com",
      },
    });

    // Reader: applyManualHostResolverRules must read the SAME file and install
    // the switch with the persisted mappings.
    const { app, calls } = makeCommandLineSpy();
    const applied = applyManualHostResolverRules(app, userDataPath);

    expect(applied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("host-resolver-rules");
    expect(calls[0]!.value).toBe(
      "MAP endpoint.example.com 10.0.0.10,MAP cdn.example.com 10.0.0.11",
    );
  });




  it("returns false when no map is configured", () => {
    const { app, calls } = makeCommandLineSpy();
    const applied = applyManualHostResolverRules(app, userDataPath);
    expect(applied).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
