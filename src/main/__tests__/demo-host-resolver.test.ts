/**
 * Demo host-resolver unit tests (Path 2 hotfix 2026-05-19).
 *
 * Verifies the env-gated `host-resolver-rules` switch wiring:
 *   - Switch applied when `LVIS_DEMO_VENDOR=azure-foundry` + non-empty map.
 *   - No-op when vendor is anything else.
 *   - No-op when `LVIS_DEMO_HOST_MAP` is unset or empty.
 *   - Parser handles malformed entries gracefully (silent drop).
 *   - Rules string matches Chromium `MAP <host> <ip>` format.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyDemoHostResolverRules,
  _testOnlyParseHostMap,
  _testOnlyBuildHostResolverRules,
} from "../demo-host-resolver.js";

function makeApp() {
  return {
    commandLine: {
      appendSwitch: vi.fn(),
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LVIS_DEMO_VENDOR;
  delete process.env.LVIS_DEMO_HOST_MAP;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("applyDemoHostResolverRules — env gating", () => {
  it("applies host-resolver-rules when vendor=azure-foundry and map is non-empty", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_HOST_MAP:
        "example.test.azure.com=10.0.0.1,other.test.azure.com=10.0.0.2",
    });
    expect(result).toBe(true);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      "host-resolver-rules",
      "MAP example.test.azure.com 10.0.0.1,MAP other.test.azure.com 10.0.0.2",
    );
  });

  it("is a no-op when vendor is not azure-foundry", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "openai",
      LVIS_DEMO_HOST_MAP: "example.test.azure.com=10.0.0.1",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("is a no-op when vendor env is unset", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {});
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("is a no-op when LVIS_DEMO_HOST_MAP is empty", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_HOST_MAP: "",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("is a no-op when LVIS_DEMO_HOST_MAP is unset", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});

describe("parseHostMap — format handling", () => {
  it("parses comma-separated host=ip pairs", () => {
    expect(
      _testOnlyParseHostMap("a.example.com=1.2.3.4,b.example.com=5.6.7.8"),
    ).toEqual([
      ["a.example.com", "1.2.3.4"],
      ["b.example.com", "5.6.7.8"],
    ]);
  });

  it("trims whitespace around entries, hosts, and ips", () => {
    expect(
      _testOnlyParseHostMap(" a.example.com = 1.2.3.4 , b.example.com=5.6.7.8 "),
    ).toEqual([
      ["a.example.com", "1.2.3.4"],
      ["b.example.com", "5.6.7.8"],
    ]);
  });

  it("drops entries with missing equals separator", () => {
    expect(_testOnlyParseHostMap("only-host,a.example.com=1.2.3.4")).toEqual([
      ["a.example.com", "1.2.3.4"],
    ]);
  });

  it("drops entries with empty host or empty ip", () => {
    expect(_testOnlyParseHostMap("=1.2.3.4,a.example.com=,b=2.2.2.2")).toEqual([
      ["b", "2.2.2.2"],
    ]);
  });

  it("returns empty array for undefined/null/empty input", () => {
    expect(_testOnlyParseHostMap(undefined)).toEqual([]);
    expect(_testOnlyParseHostMap("")).toEqual([]);
  });
});

describe("buildHostResolverRules — Chromium format", () => {
  it("emits MAP <host> <ip> clauses joined by commas", () => {
    expect(
      _testOnlyBuildHostResolverRules([
        ["a.example.com", "1.2.3.4"],
        ["b.example.com", "5.6.7.8"],
      ]),
    ).toBe("MAP a.example.com 1.2.3.4,MAP b.example.com 5.6.7.8");
  });

  it("returns empty string for empty input", () => {
    expect(_testOnlyBuildHostResolverRules([])).toBe("");
  });
});
