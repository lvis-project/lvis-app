/**
 * M2 — Telemetry endpoint URL validation.
 *
 * Locks in the guardrails:
 *   - only https:// is accepted
 *   - host must be in the (default or env-override) allowlist
 *   - localhost is rejected in packaged builds
 *   - invalid endpoint → one audit warn + session-disabled (no retry)
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TELEMETRY_ALLOWLIST,
  TelemetryService,
  sanitizeUrlForAudit,
  validateTelemetryEndpoint,
} from "../telemetry.js";
import type { TelemetrySettings } from "../../data/settings-store.js";

describe("validateTelemetryEndpoint — schemes", () => {
  it("accepts https://", () => {
    expect(
      validateTelemetryEndpoint("https://telemetry.lge.com/ingest", {
        isPackaged: true,
      }).valid,
    ).toBe(true);
  });

  it("rejects http://", () => {
    const r = validateTelemetryEndpoint("http://telemetry.lge.com/ingest", {
      isPackaged: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/protocol/);
  });

  it("rejects file://", () => {
    const r = validateTelemetryEndpoint("file:///etc/passwd", { isPackaged: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/protocol/);
  });

  it("rejects data: and javascript: URIs", () => {
    expect(
      validateTelemetryEndpoint("data:text/plain;base64,SGVsbG8=", { isPackaged: true }).valid,
    ).toBe(false);
    expect(
      validateTelemetryEndpoint("javascript:alert(1)", { isPackaged: true }).valid,
    ).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(validateTelemetryEndpoint("not a url", { isPackaged: true }).valid).toBe(false);
    expect(validateTelemetryEndpoint("", { isPackaged: true }).valid).toBe(false);
    expect(validateTelemetryEndpoint(undefined, { isPackaged: true }).valid).toBe(false);
  });
});

describe("validateTelemetryEndpoint — allowlist", () => {
  it("accepts telemetry.lge.com by default", () => {
    expect(
      validateTelemetryEndpoint("https://telemetry.lge.com/x", { isPackaged: true }).valid,
    ).toBe(true);
  });

  it("rejects hosts not in the default allowlist", () => {
    const r = validateTelemetryEndpoint("https://evil.example.com/x", { isPackaged: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/allowlist/);
  });

  it("honors LVIS_TELEMETRY_ALLOWLIST env override (comma-separated)", () => {
    const r = validateTelemetryEndpoint("https://custom.corp.example/x", {
      isPackaged: true,
      allowlistEnv: "custom.corp.example,another.host.net",
    });
    expect(r.valid).toBe(true);
  });

  it("env override fully replaces default (e.g. telemetry.lge.com becomes rejected)", () => {
    const r = validateTelemetryEndpoint("https://telemetry.lge.com/x", {
      isPackaged: true,
      allowlistEnv: "only.this.host",
    });
    expect(r.valid).toBe(false);
  });

  it("sanity — DEFAULT_TELEMETRY_ALLOWLIST exposes the documented hosts", () => {
    expect(DEFAULT_TELEMETRY_ALLOWLIST).toContain("telemetry.lge.com");
    expect(DEFAULT_TELEMETRY_ALLOWLIST).toContain("localhost");
  });
});

describe("validateTelemetryEndpoint — localhost + isPackaged", () => {
  it("allows localhost in dev (isPackaged=false)", () => {
    const r = validateTelemetryEndpoint("https://localhost:4000/x", { isPackaged: false });
    expect(r.valid).toBe(true);
  });

  it("rejects localhost in packaged build", () => {
    const r = validateTelemetryEndpoint("https://localhost:4000/x", { isPackaged: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/packaged/);
  });
});

describe("sanitizeUrlForAudit", () => {
  it("strips userinfo (user:pass@)", () => {
    expect(sanitizeUrlForAudit("https://user:pw@example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("strips query string", () => {
    expect(sanitizeUrlForAudit("https://host.example/x?token=secret")).toBe(
      "https://host.example/x",
    );
  });

  it("strips fragment", () => {
    expect(sanitizeUrlForAudit("https://host.example/x#bearer=abc")).toBe(
      "https://host.example/x",
    );
  });

  it("preserves port in host", () => {
    expect(sanitizeUrlForAudit("https://host.example:8443/x")).toBe(
      "https://host.example:8443/x",
    );
  });

  it("returns an unparseable marker for garbage input", () => {
    const out = sanitizeUrlForAudit("not a url");
    expect(out).toMatch(/unparseable/);
  });

  it("truncates unparseable input to 80 chars of content", () => {
    const long = "x".repeat(500);
    const out = sanitizeUrlForAudit(long) ?? "";
    // "[unparseable] " prefix + 80 chars of content
    expect(out.length).toBeLessThanOrEqual("[unparseable] ".length + 80);
  });

  it("returns undefined for non-string / empty", () => {
    expect(sanitizeUrlForAudit(undefined)).toBeUndefined();
    expect(sanitizeUrlForAudit("")).toBeUndefined();
    expect(sanitizeUrlForAudit(42)).toBeUndefined();
  });
});

describe("TelemetryService — audit log uses warn + sanitized url", () => {
  it("logs type=warn (not error) and strips query string when endpoint rejected", () => {
    const entries: Array<Record<string, unknown>> = [];
    const svc = new TelemetryService({
      settings: () => ({ enabled: true, endpoint: "http://bad.example/x?secret=abc" } as TelemetrySettings),
      isPackaged: true,
      auditLogger: { log: (e) => entries.push(e) },
    });
    expect(svc.isActive()).toBe(false);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("warn");
    expect(String(entries[0].output)).toBe("http://bad.example/x");
    expect(String(entries[0].output)).not.toContain("secret");
  });
});

describe("TelemetryService — isActive() + audit on invalid endpoint", () => {
  function makeLogger() {
    const entries: Array<Record<string, unknown>> = [];
    return {
      entries,
      logger: { log: (e: Record<string, unknown>) => entries.push(e) },
    };
  }

  function makeSettings(over: Partial<TelemetrySettings>): () => TelemetrySettings {
    return () => ({ enabled: true, ...over } as TelemetrySettings);
  }

  it("isActive() is false when endpoint is http://", () => {
    const { logger, entries } = makeLogger();
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "http://telemetry.lge.com/x" }),
      isPackaged: true,
      auditLogger: logger,
    });
    expect(svc.isActive()).toBe(false);
    expect(entries.length).toBe(1);
    expect(String(entries[0].input)).toMatch(/endpoint rejected/);
  });

  it("isActive() is false when host not in allowlist", () => {
    const { logger } = makeLogger();
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "https://evil.example.com/x" }),
      isPackaged: true,
      auditLogger: logger,
    });
    expect(svc.isActive()).toBe(false);
  });

  it("isActive() is true when endpoint is https + allowlist host (dev localhost)", () => {
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "https://localhost:4000/x" }),
      isPackaged: false,
    });
    expect(svc.isActive()).toBe(true);
  });

  it("isActive() rejects localhost in packaged build", () => {
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "https://localhost:4000/x" }),
      isPackaged: true,
    });
    expect(svc.isActive()).toBe(false);
  });

  it("session-disables after first invalid endpoint — no retries", () => {
    const { logger, entries } = makeLogger();
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "http://bad/x" }),
      isPackaged: true,
      auditLogger: logger,
    });
    expect(svc.isActive()).toBe(false);
    expect(svc.isActive()).toBe(false);
    expect(svc.isActive()).toBe(false);
    // exactly one audit entry — session-disabled after first check.
    expect(entries.length).toBe(1);
  });

  it("flush() is a no-op when endpoint is invalid", async () => {
    let fetched = 0;
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "http://bad/x" }),
      isPackaged: true,
      fetchImpl: (async () => {
        fetched += 1;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    svc.track("app_start");
    await svc.flush();
    expect(fetched).toBe(0);
  });

  it("honors allowlistEnv override in TelemetryService", () => {
    const svc = new TelemetryService({
      settings: makeSettings({ endpoint: "https://custom.corp.example/x" }),
      isPackaged: true,
      allowlistEnv: "custom.corp.example",
    });
    expect(svc.isActive()).toBe(true);
  });
});
