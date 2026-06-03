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
  demoHostMapContainsHost,
  demoFoundryHostMapFingerprint,
  getAppliedDemoHostResolverFingerprint,
  parseAllowedSubnets,
  validateDemoFoundryHostMap,
  _testOnlyResetAppliedDemoHostResolverFingerprint,
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
  _testOnlyResetAppliedDemoHostResolverFingerprint();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("applyDemoHostResolverRules — env gating", () => {
  it("applies host-resolver-rules when vendor=azure-foundry and endpoint host map is valid", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
      LVIS_DEMO_HOST_MAP:
        "example.test.openai.azure.com=10.182.192.10,example.test.services.ai.azure.com=10.182.192.11",
    });
    expect(result).toBe(true);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      "host-resolver-rules",
      "MAP example.test.openai.azure.com 10.182.192.10,MAP example.test.services.ai.azure.com 10.182.192.11",
    );
    expect(getAppliedDemoHostResolverFingerprint()).toBe(
      "example.test.openai.azure.com|MAP example.test.openai.azure.com 10.182.192.10,MAP example.test.services.ai.azure.com 10.182.192.11",
    );
  });

  it("skips the whole mapping when any target is outside the approved demo subnet", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
      LVIS_DEMO_HOST_MAP:
        "example.test.openai.azure.com=10.182.192.10,example.test.services.ai.azure.com=169.254.169.254",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(getAppliedDemoHostResolverFingerprint()).toBeNull();
  });

  it("skips mapping when the Azure Foundry endpoint is missing", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_HOST_MAP: "example.test.openai.azure.com=10.182.192.10",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("skips mapping when the endpoint is not a valid Azure Foundry endpoint", () => {
    const nonFoundryApp = makeApp();
    expect(
      applyDemoHostResolverRules(nonFoundryApp, {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://attacker.example.com/openai/v1/",
        LVIS_DEMO_HOST_MAP: "attacker.example.com=10.182.192.10",
      }),
    ).toBe(false);
    expect(nonFoundryApp.commandLine.appendSwitch).not.toHaveBeenCalled();

    const nonHttpsApp = makeApp();
    expect(
      applyDemoHostResolverRules(nonHttpsApp, {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "http://example.test.openai.azure.com/openai/v1/",
        LVIS_DEMO_HOST_MAP:
          "example.test.openai.azure.com=10.182.192.10",
      }),
    ).toBe(false);
    expect(nonHttpsApp.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("skips mapping when the map does not cover the endpoint host", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
      LVIS_DEMO_HOST_MAP: "other.test.openai.azure.com=10.182.192.10",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("skips mapping when the map includes unrelated or wildcard hosts", () => {
    const app = makeApp();
    expect(
      applyDemoHostResolverRules(app, {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
        LVIS_DEMO_HOST_MAP:
          "example.test.openai.azure.com=10.182.192.10,unrelated.openai.azure.com=10.182.192.11",
      }),
    ).toBe(false);
    expect(
      applyDemoHostResolverRules(makeApp(), {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
        LVIS_DEMO_HOST_MAP:
          "example.test.openai.azure.com=10.182.192.10,*=10.182.192.11",
      }),
    ).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
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
      LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
      LVIS_DEMO_HOST_MAP: "",
    });
    expect(result).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("is a no-op when LVIS_DEMO_HOST_MAP is unset", () => {
    const app = makeApp();
    const result = applyDemoHostResolverRules(app, {
      LVIS_DEMO_VENDOR: "azure-foundry",
      LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
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

describe("demoHostMapContainsHost", () => {
  it("matches URL hostnames against the Chromium resolver host map", () => {
    const raw = "example.test.openai.azure.com=10.182.192.10";

    expect(demoHostMapContainsHost(raw, "https://example.test.openai.azure.com/openai/v1/")).toBe(true);
    expect(demoHostMapContainsHost(raw, "https://other.test.openai.azure.com/openai/v1/")).toBe(false);
  });
});

describe("validateDemoFoundryHostMap — endpoint coverage", () => {
  it("passes when the map contains the endpoint host", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.30,endpoint.services.ai.azure.com=10.182.192.31",
      ),
    ).toBeNull();
  });

  it("rejects matching endpoint hosts mapped outside the approved demo subnet", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=127.0.0.1",
      ),
    ).toBe("invalid-foundry-host-map-target");
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=169.254.169.254",
      ),
    ).toBe("invalid-foundry-host-map-target");
    // 10.182.193.30 is in RFC1918 (10.0.0.0/8) so it is allowed by the generic
    // default; it must be rejected only when the activation key narrows the
    // allowed subnet to a /24 that excludes it.
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.193.30",
        "10.182.192.0/24",
      ),
    ).toBe("invalid-foundry-host-map-target");
  });

  it("rejects extra host mappings outside the approved demo subnet", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.30,other.openai.azure.com=127.0.0.1",
      ),
    ).toBe("invalid-foundry-host-map-target");
  });

  it("requires a non-empty host map", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        undefined,
      ),
    ).toBe("missing-foundry-host-map");
  });

  it("rejects maps that do not cover the endpoint host", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "other.openai.azure.com=10.182.192.31",
      ),
    ).toBe("foundry-host-map-mismatch");
  });

  it("rejects unrelated extra hosts even when they target the approved subnet", () => {
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.30,unrelated.openai.azure.com=10.182.192.31",
      ),
    ).toBe("foundry-host-map-mismatch");
    expect(
      validateDemoFoundryHostMap(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.30,*=10.182.192.31",
      ),
    ).toBe("foundry-host-map-mismatch");
  });
});

describe("allowed-subnet sourcing (LVIS_DEMO_HOST_SUBNET)", () => {
  it("parseAllowedSubnets parses comma-separated CIDRs and drops malformed ones", () => {
    expect(parseAllowedSubnets("10.182.192.0/24, 192.168.0.0/16")).toEqual([
      "10.182.192.0/24",
      "192.168.0.0/16",
    ]);
    expect(parseAllowedSubnets("not-a-cidr,10.0.0.0/33,10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    expect(parseAllowedSubnets(undefined)).toEqual([]);
    expect(parseAllowedSubnets("")).toEqual([]);
  });

  it("treats an absent/empty/whitespace-only subnet as 'not provided' (RFC1918 fallback, not fail-closed)", () => {
    const base = "https://endpoint.openai.azure.com/openai/v1/";
    // undefined and whitespace-only are the benign "absent" case → RFC1918
    // floor still applies (an in-RFC1918 target passes), NOT the fail-closed
    // path reserved for a present-but-malformed narrowing directive.
    for (const absent of [undefined, "", "   ", "\t"]) {
      expect(
        validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=10.182.192.7", absent),
        `subnet ${JSON.stringify(absent)} must use the RFC1918 fallback`,
      ).toBeNull();
    }
  });

  it("defaults to generic private (RFC1918) ranges when no subnet is provided", () => {
    // 10.x / 172.16.x / 192.168.x targets pass; public + loopback + link-local fail.
    const base = "https://endpoint.openai.azure.com/openai/v1/";
    expect(validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=10.182.192.5")).toBeNull();
    expect(validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=192.168.4.4")).toBeNull();
    expect(validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=8.8.8.8")).toBe(
      "invalid-foundry-host-map-target",
    );
    expect(validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=127.0.0.1")).toBe(
      "invalid-foundry-host-map-target",
    );
  });

  it("narrows the allowed targets to the activation-key subnet when provided", () => {
    const base = "https://endpoint.openai.azure.com/openai/v1/";
    // In-subnet target passes...
    expect(
      validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=10.182.192.7", "10.182.192.0/24"),
    ).toBeNull();
    // ...a 10.x outside the /24 is rejected even though it is RFC1918.
    expect(
      validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=10.182.193.7", "10.182.192.0/24"),
    ).toBe("invalid-foundry-host-map-target");
  });

  it("applyDemoHostResolverRules honors a key-provided subnet", () => {
    const app = makeApp();
    // Target outside the key subnet → mapping skipped.
    expect(
      applyDemoHostResolverRules(app, {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
        LVIS_DEMO_HOST_MAP: "example.test.openai.azure.com=10.182.193.10",
        LVIS_DEMO_HOST_SUBNET: "10.182.192.0/24",
      }),
    ).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when a provided subnet is present but entirely unparseable", () => {
    const base = "https://endpoint.openai.azure.com/openai/v1/";
    // A typo'd narrowing directive must NOT silently widen back to RFC1918 —
    // an in-RFC1918 target that would pass the default must be rejected.
    for (const badSubnet of ["10.182.192/24", "10.182.192.0", "/24", "garbage,also-bad", "10.0.0.0/33"]) {
      expect(
        validateDemoFoundryHostMap(base, "endpoint.openai.azure.com=10.182.192.7", badSubnet),
        `subnet "${badSubnet}" must fail closed`,
      ).toBe("invalid-foundry-host-map-target");
      expect(
        demoFoundryHostMapFingerprint(base, "endpoint.openai.azure.com=10.182.192.7", badSubnet),
        `subnet "${badSubnet}" must produce no fingerprint`,
      ).toBeNull();
    }
  });

  it("applyDemoHostResolverRules fails closed on a malformed subnet directive", () => {
    const app = makeApp();
    expect(
      applyDemoHostResolverRules(app, {
        LVIS_DEMO_VENDOR: "azure-foundry",
        LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY: "https://example.test.openai.azure.com/openai/v1/",
        LVIS_DEMO_HOST_MAP: "example.test.openai.azure.com=10.182.192.10",
        LVIS_DEMO_HOST_SUBNET: "not-a-cidr",
      }),
    ).toBe(false);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});

describe("demoFoundryHostMapFingerprint", () => {
  it("normalizes host case and entry order for equivalent maps", () => {
    const left = demoFoundryHostMapFingerprint(
      "https://endpoint.openai.azure.com/openai/v1/",
      "endpoint.services.ai.azure.com=10.182.192.12,ENDPOINT.openai.azure.com=10.182.192.11",
    );
    const right = demoFoundryHostMapFingerprint(
      "https://endpoint.openai.azure.com/openai/v1/",
      "endpoint.openai.azure.com=10.182.192.11,endpoint.services.ai.azure.com=10.182.192.12",
    );
    expect(left).toBe(right);
  });

  it("changes when the mapped endpoint or host map changes", () => {
    const boot = demoFoundryHostMapFingerprint(
      "https://endpoint.openai.azure.com/openai/v1/",
      "endpoint.openai.azure.com=10.182.192.11",
    );
    expect(
      demoFoundryHostMapFingerprint(
        "https://new-endpoint.openai.azure.com/openai/v1/",
        "new-endpoint.openai.azure.com=10.182.192.11",
      ),
    ).not.toBe(boot);
    expect(
      demoFoundryHostMapFingerprint(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.12",
      ),
    ).not.toBe(boot);
  });

  it("returns null for invalid endpoint or invalid host map state", () => {
    expect(
      demoFoundryHostMapFingerprint(
        "not-a-url",
        "endpoint.openai.azure.com=10.182.192.11",
      ),
    ).toBeNull();
    expect(
      demoFoundryHostMapFingerprint(
        "https://attacker.example.com/openai/v1/",
        "attacker.example.com=10.182.192.11",
      ),
    ).toBeNull();
    expect(
      demoFoundryHostMapFingerprint(
        "http://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=10.182.192.11",
      ),
    ).toBeNull();
    expect(
      demoFoundryHostMapFingerprint(
        "https://endpoint.openai.azure.com/openai/v1/",
        "endpoint.openai.azure.com=127.0.0.1",
      ),
    ).toBeNull();
  });
});
