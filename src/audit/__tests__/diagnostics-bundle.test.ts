/**
 * Diagnostics bundle writer (#1499 E2) — the SECURITY-CRITICAL tests.
 *
 * The single most important property: a PII / secret injected into ANY source
 * (settings, audit trail, log file) must NOT appear anywhere in the produced
 * ZIP. These tests unzip the bundle and assert the raw bytes are clean, per
 * secret/PII class (API key, DSN, email, phone, SSN, CC).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { AuditLogger } from "../audit-logger.js";
import {
  buildDiagnosticsBundle,
  pickRedactedSettings,
  listCrashDumps,
} from "../diagnostics-bundle.js";
import type { AppSettings } from "../../data/settings-store.js";

let tmp: string;
let auditDir: string;
let logsDir: string;
let crashDir: string;

/** Minimal AppSettings fixture with secrets planted in every secret-bearing field. */
function makeSettings(): AppSettings {
  return {
    llm: {
      authMode: "manual",
      provider: "anthropic",
      streamSmoothing: "none",
      fallbackChain: [],
      hostResolverMap: "10.0.0.1 secret-internal-host.corp",
      vendors: {
        anthropic: { model: "claude-x", apiKey: "sk-ant-SUPERSECRETKEY123", baseUrl: "https://api.example.com" },
      } as unknown as AppSettings["llm"]["vendors"],
    },
    chat: { systemPrompt: "sp", autoCompact: true },
    webSearch: { provider: "duckduckgo" },
    marketplace: { backend: "real-cloud", cloudBaseUrl: "https://m.example.com" },
    routine: {},
    privacy: { piiRedactEnabled: false },
    updates: { autoCheckEnabled: true },
    telemetry: {
      enabled: false,
      crashReportingEnabled: false,
      sentryDsn: "https://abc123@o42.ingest.sentry.io/99",
      endpoint: "https://telemetry.example.com/collect",
      crashReportEndpoint: "https://crash.example.com/submit",
    },
    audit: { auditRotationMaxBytes: 1000, auditRetentionDays: 30 },
    diagnostics: { includeCrashDumps: false, logRetentionDays: 7 },
    appearance: { schemaVersion: 2, bundleId: "violet-dark", language: "en" },
    webView: { preferredFlow: "in-app" },
    system: { closeBehavior: "hide-to-tray", appMode: "work", pinnedProjectRoots: ["/Users/secretuser/private"] } as unknown as AppSettings["system"],
    shortcuts: { toggleWindow: null, enabled: false } as unknown as AppSettings["shortcuts"],
    plugins: {},
    pluginConfigs: {},
    features: {},
  } as AppSettings;
}

function unzipToText(buffer: Buffer): { names: string[]; allText: string } {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const names = entries.map((e) => e.entryName);
  const allText = entries.map((e) => e.getData().toString("utf-8")).join("\n");
  return { names, allText };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lvis-diag-test-"));
  auditDir = join(tmp, "audit");
  logsDir = join(tmp, "logs");
  crashDir = join(tmp, "crash-dumps");
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(crashDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

async function build(overrides: Partial<Parameters<typeof buildDiagnosticsBundle>[0]> = {}): Promise<Buffer> {
  const auditLogger = new AuditLogger(auditDir);
  return buildDiagnosticsBundle({
    settings: makeSettings(),
    auditLogger,
    appVersion: "9.9.9-test",
    crashDumpsDir: crashDir,
    logsDir,
    dateFrom: "2020-01-01",
    dateTo: "2099-01-01",
    runtime: { electron: "e", node: "n", chrome: "c" },
    osRelease: "test-release",
    ...overrides,
  });
}

describe("pickRedactedSettings — deny-by-default whitelist", () => {
  it("omits every secret field", () => {
    const out = pickRedactedSettings(makeSettings());
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-ant-SUPERSECRETKEY123"); // apiKey
    expect(json).not.toContain("sentry.io"); // DSN host
    expect(json).not.toContain("telemetry.example.com"); // endpoint
    expect(json).not.toContain("crash.example.com"); // crashReportEndpoint
    expect(json).not.toContain("secret-internal-host"); // hostResolverMap
    expect(json).not.toContain("secretuser"); // pinnedProjectRoots path
  });

  it("keeps safe provider/model shape", () => {
    const out = pickRedactedSettings(makeSettings()) as { llm: { provider: string; vendors: Record<string, { model?: string; hasBaseUrl: boolean }> } };
    expect(out.llm.provider).toBe("anthropic");
    expect(out.llm.vendors.anthropic.model).toBe("claude-x");
    // baseUrl becomes a presence flag, never the value.
    expect(out.llm.vendors.anthropic.hasBaseUrl).toBe(true);
    expect(JSON.stringify(out)).not.toContain("api.example.com");
  });
});

describe("buildDiagnosticsBundle — PII / secret exclusion", () => {
  it("secrets from settings never reach the ZIP", async () => {
    const { allText } = unzipToText(await build());
    expect(allText).not.toContain("sk-ant-SUPERSECRETKEY123");
    expect(allText).not.toContain("sentry.io");
    expect(allText).not.toContain("telemetry.example.com");
    expect(allText).not.toContain("crash.example.com");
    expect(allText).not.toContain("secret-internal-host");
  });

  it("email / phone / SSN / CC in log lines are redacted", async () => {
    writeFileSync(
      join(logsDir, "lvis-2025-06-01.log"),
      [
        JSON.stringify({ level: 30, msg: "user victim@example.com logged in" }),
        JSON.stringify({ level: 30, msg: "call 010-1234-5678 now" }),
        JSON.stringify({ level: 30, msg: "ssn 900101-1234567 leaked" }),
        JSON.stringify({ level: 30, msg: "card 4111 1111 1111 1111 charged" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const { allText } = unzipToText(await build());
    expect(allText).not.toContain("victim@example.com");
    expect(allText).not.toContain("010-1234-5678");
    expect(allText).not.toContain("900101-1234567");
    expect(allText).not.toContain("4111 1111 1111 1111");
    // The redaction markers ARE present (proof the line was processed, not dropped).
    expect(allText).toContain("[REDACTED:EMAIL]");
  });

  it("MCP stderr in the log file is redacted at the bundle chokepoint (§5d)", async () => {
    // mcp-client pipes MCP server stderr into the app logger, so it lands in the
    // log file. The bundle's line-level redactForLLM is the single point that
    // covers it — no mcp-client change needed. Proven here.
    writeFileSync(
      join(logsDir, "lvis-2025-06-02.log"),
      JSON.stringify({ level: 40, msg: "[mcp stderr] leaked admin@corp.com token" }) + "\n",
      "utf-8",
    );
    const { allText } = unzipToText(await build());
    expect(allText).not.toContain("admin@corp.com");
    expect(allText).toContain("[REDACTED:EMAIL]");
  });

  it("audit entry input/output PII is redacted", async () => {
    const logger = new AuditLogger(auditDir);
    logger.log({
      timestamp: "2025-06-01T00:00:00.000Z",
      sessionId: "s1",
      type: "turn",
      input: "reach me at pii@leak.com",
      output: "or 010-9999-8888",
    });
    const { allText } = unzipToText(await build({ auditLogger: logger }));
    expect(allText).not.toContain("pii@leak.com");
    expect(allText).not.toContain("010-9999-8888");
  });
});

describe("buildDiagnosticsBundle — crash dumps", () => {
  it("metadata only by default; binaries excluded", async () => {
    writeFileSync(join(crashDir, "boom.dmp"), "RAWCRASHBINARYSECRET", "utf-8");
    const { names, allText } = unzipToText(await build({ includeCrashDumps: false }));
    expect(names).toContain("crash-dumps/index.json");
    expect(names).not.toContain("crash-dumps/boom.dmp");
    expect(allText).not.toContain("RAWCRASHBINARYSECRET");
    expect(allText).toContain("boom.dmp"); // filename metadata present
  });

  it("includes binaries when opted in", async () => {
    writeFileSync(join(crashDir, "boom.dmp"), "RAWCRASH", "utf-8");
    const { names } = unzipToText(await build({ includeCrashDumps: true }));
    expect(names).toContain("crash-dumps/boom.dmp");
  });

  it("listCrashDumps returns filename metadata only, no path", () => {
    writeFileSync(join(crashDir, "a.dmp"), "x", "utf-8");
    const metas = listCrashDumps(crashDir);
    expect(metas).toHaveLength(1);
    expect(metas[0].name).toBe("a.dmp");
    expect(metas[0].name).not.toContain(crashDir);
  });
});

describe("buildDiagnosticsBundle — resilience", () => {
  it("empty sources produce a valid manifest, no throw", async () => {
    const { names, allText } = unzipToText(await build());
    expect(names).toContain("manifest.json");
    const manifest = JSON.parse(
      new AdmZip(await build()).getEntry("manifest.json")!.getData().toString("utf-8"),
    );
    expect(manifest.appVersion).toBe("9.9.9-test");
    expect(manifest.truncated).toBe(false);
    // settings-redacted always present.
    expect(allText).toContain("settings-redacted.json");
  });

  it("missing source dirs are graceful (no logs/crash dirs)", async () => {
    rmSync(logsDir, { recursive: true, force: true });
    rmSync(crashDir, { recursive: true, force: true });
    const buf = await build();
    const { names } = unzipToText(buf);
    expect(names).toContain("manifest.json");
    expect(names).toContain("settings-redacted.json");
  });

  it("size ceiling truncates and flags manifest", async () => {
    // One large log line, tiny ceiling → truncated.
    writeFileSync(join(logsDir, "lvis-2025-06-03.log"), "x".repeat(5000) + "\n", "utf-8");
    const buf = await build({ maxBytes: 500 });
    const manifest = JSON.parse(new AdmZip(buf).getEntry("manifest.json")!.getData().toString("utf-8"));
    expect(manifest.truncated).toBe(true);
  });
});
