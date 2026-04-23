import { describe, expect, it } from "vitest";
import {
  DEFAULT_MS_GRAPH_ENVIRONMENT,
  MS_GRAPH_ENVIRONMENTS,
  MS_GRAPH_ENVIRONMENT_CONFIGS,
  getEnvironmentConfig,
  isEnvironmentConfigured,
  normalizeEnvironment,
} from "../ms-graph-auth-config.js";

describe("ms-graph-auth-config", () => {
  it("exposes both environments", () => {
    expect(MS_GRAPH_ENVIRONMENTS).toEqual(["external", "corporate"]);
  });

  it("external environment is fully configured (real client + common authority)", () => {
    const cfg = getEnvironmentConfig("external");
    expect(cfg.clientId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(cfg.authority).toBe("https://login.microsoftonline.com/common");
    expect(cfg.scopes).toContain("User.Read");
    expect(cfg.scopes).toContain("offline_access");
    expect(cfg.scopes).not.toContain("Mail.Send");
    expect(cfg.scopes).not.toContain("Calendars.ReadWrite");
    expect(isEnvironmentConfigured("external")).toBe(true);
  });

  it("corporate environment has real clientId (LVIS Desktop Assistant)", () => {
    const cfg = getEnvironmentConfig("corporate");
    expect(cfg.clientId).not.toMatch(/__FILL_IN/);
    expect(cfg.clientId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("corporate is configured once tenantId is filled in", () => {
    const cfg = getEnvironmentConfig("corporate");
    const configured = isEnvironmentConfigured("corporate");
    const tenantFilled = !cfg.authority.includes("__FILL_IN");
    // Invariant: configured iff both client and tenant are real values
    expect(configured).toBe(tenantFilled);
  });

  it("normalizeEnvironment rejects unknown values → default", () => {
    expect(normalizeEnvironment("external")).toBe("external");
    expect(normalizeEnvironment("corporate")).toBe("corporate");
    expect(normalizeEnvironment("")).toBe(DEFAULT_MS_GRAPH_ENVIRONMENT);
    expect(normalizeEnvironment(undefined)).toBe(DEFAULT_MS_GRAPH_ENVIRONMENT);
    expect(normalizeEnvironment("hackers")).toBe(DEFAULT_MS_GRAPH_ENVIRONMENT);
    expect(normalizeEnvironment({ env: "corporate" })).toBe(
      DEFAULT_MS_GRAPH_ENVIRONMENT,
    );
  });

  it("all environment configs have label + description", () => {
    for (const env of MS_GRAPH_ENVIRONMENTS) {
      const cfg = MS_GRAPH_ENVIRONMENT_CONFIGS[env];
      expect(cfg.label.length).toBeGreaterThan(0);
      expect(cfg.description.length).toBeGreaterThan(10);
    }
  });

  it("scopes list shared across environments (equal by default)", () => {
    const ext = getEnvironmentConfig("external").scopes;
    const corp = getEnvironmentConfig("corporate").scopes;
    expect(corp).toEqual(ext);
  });
});
