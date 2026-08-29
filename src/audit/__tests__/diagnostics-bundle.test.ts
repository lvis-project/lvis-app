/**
 * Diagnostics bundle writer (#1499 E2) — the SECURITY-CRITICAL tests.
 *
 * The single most important property: a PII / secret injected into ANY source
 * (settings, audit trail, log file) must NOT appear anywhere in the produced
 * ZIP. These tests unzip the bundle and assert the raw bytes are clean, per
 * secret/PII class (API key, DSN, email, phone, SSN, CC).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
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
  const settings = {
    llm: {
      // A vendor the store recognises: settings reach every reader through
      // SettingsService, which coerces an unknown provider name at the file
      // boundary, so a fixture naming one would be testing a state no caller
      // can be handed.
      provider: "claude",
      streamSmoothing: "none",
      fallbackChain: [],
      vendors: {
        claude: { model: "claude-x", apiKey: "sk-ant-SUPERSECRETKEY123", baseUrl: "https://api.example.com" },
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
  // A settings file written by an older build can still carry llm keys that
  // no longer exist in `LLMSettings` — e.g. the removed manual host-resolver
  // map, whose value is a user-authored internal-hostname mapping. Planting
  // one here keeps the deny-by-default allowlist under test for keys the
  // current type system cannot even name.
  (settings.llm as unknown as Record<string, unknown>).hostResolverMap =
    "10.0.0.1 secret-internal-host.corp";
  return settings;
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

afterEach(async () => {
  if (existsSync(tmp)) await cleanupTmpDir(tmp);
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
    expect(json).not.toContain("secret-internal-host"); // legacy/unknown llm key
    expect(json).not.toContain("secretuser"); // pinnedProjectRoots path
  });

  it("keeps safe provider/model shape", () => {
    const out = pickRedactedSettings(makeSettings()) as { llm: { provider: string; vendors: Record<string, { model?: string; hasBaseUrl: boolean }> } };
    expect(out.llm.provider).toBe("claude");
    expect(out.llm.vendors.claude.model).toBe("claude-x");
    // baseUrl becomes a presence flag, never the value.
    expect(out.llm.vendors.claude.hasBaseUrl).toBe(true);
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

  it("credential-class secrets in log lines are scrubbed (sk-/Bearer/JWT/x-api-key)", async () => {
    // The PII pass (redactForLLM) does NOT cover tokens/keys; the bundle must
    // ALSO apply scrubSecretsForLLM per line (security MAJOR M1). Inject the
    // real secret shapes and assert they never reach the ZIP. The prior test
    // only asserted email, masking this gap.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    writeFileSync(
      join(logsDir, "lvis-2025-06-04.log"),
      [
        JSON.stringify({ level: 30, msg: "key sk-ant-SUPERSECRETKEY123456 used" }),
        JSON.stringify({ level: 30, msg: "Authorization: Bearer abcDEF123456tokenvalue" }),
        JSON.stringify({ level: 30, msg: `token ${jwt}` }),
        JSON.stringify({ level: 30, msg: "x-api-key: liveKEY9876543210value" }),
        JSON.stringify({ level: 30, msg: "url https://x.example/mcp?api_key=SECRETPARAM123" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const { allText } = unzipToText(await build());
    expect(allText).not.toContain("sk-ant-SUPERSECRETKEY123456");
    expect(allText).not.toContain("abcDEF123456tokenvalue");
    expect(allText).not.toContain(jwt);
    expect(allText).not.toContain("liveKEY9876543210value");
    expect(allText).not.toContain("SECRETPARAM123");
    // The credential redaction markers ARE present (proof the line was scrubbed).
    expect(allText).toContain("[REDACTED:TOKEN]");
    expect(allText).toContain("[REDACTED:JWT]");
  });

  it("credential-class secrets in audit input/output are scrubbed", async () => {
    const logger = new AuditLogger(auditDir);
    logger.log({
      timestamp: "2025-06-01T00:00:00.000Z",
      sessionId: "s1",
      type: "turn",
      input: "here is my key sk-live-AUDITSECRETKEY987654",
      output: "Authorization: Bearer auditBEARERtokenXYZ123",
    });
    const { allText } = unzipToText(await build({ auditLogger: logger }));
    expect(allText).not.toContain("sk-live-AUDITSECRETKEY987654");
    expect(allText).not.toContain("auditBEARERtokenXYZ123");
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

/**
 * The window is picked in HOST-LOCAL civil days; the audit store partitions by
 * UTC day and the log files are NAMED for one. East of Greenwich the two
 * calendars disagree through the first hours of every local day, and a default
 * window built from UTC keys used to end on the local day BEFORE the current
 * one — losing the audit rows and the log file the support request is about.
 *
 * The clock is pinned to 01:00 on the 16th in Seoul (16:00Z on the 15th) so the
 * disagreement is present in both the UTC and the Asia/Seoul suite run, instead
 * of only during the hours the suite happens to be started in.
 */
describe("buildDiagnosticsBundle — default window over the local/UTC split", () => {
  const NOW = new Date("2026-06-15T16:00:00.000Z");
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("keeps audit rows written after UTC midnight but before local midnight", async () => {
    // 01:00 local on the 16th — inside the default window's last local day, and
    // written into the PREVIOUS UTC partition.
    writeFileSync(
      join(auditDir, "2026-06-15.jsonl"),
      JSON.stringify({
        timestamp: "2026-06-15T16:00:00.000Z",
        sessionId: "s",
        type: "turn",
        input: "AFTER-UTC-MIDNIGHT-MARKER",
        output: "",
      }) + "\n",
      "utf-8",
    );
    const { names, allText } = unzipToText(await build({ dateFrom: undefined, dateTo: undefined }));
    expect(names).toContain("audit/2026-06-09_2026-06-16.jsonl");
    expect(allText).toContain("AFTER-UTC-MIDNIGHT-MARKER");
  });

  it("keeps the log files named for the UTC days the local window reaches into", async () => {
    // The window's last local day (the 16th) runs to 15:00Z ON the 16th, so the
    // file named for UTC the 16th holds part of it; the first local day (the
    // 9th) begins at 15:00Z on the 8th, so the file named for the 8th does too.
    writeFileSync(join(logsDir, "lvis-2026-06-16.log"), "LAST-LOCAL-DAY-MARKER\n", "utf-8");
    writeFileSync(join(logsDir, "lvis-2026-06-08.log"), "FIRST-LOCAL-DAY-MARKER\n", "utf-8");
    writeFileSync(join(logsDir, "lvis-2026-06-07.log"), "OUTSIDE-MARKER\n", "utf-8");
    const { names, allText } = unzipToText(await build({ dateFrom: undefined, dateTo: undefined }));
    expect(names).toContain("logs/lvis-2026-06-16.log");
    expect(names).toContain("logs/lvis-2026-06-08.log");
    expect(names).not.toContain("logs/lvis-2026-06-07.log");
    expect(allText).toContain("LAST-LOCAL-DAY-MARKER");
    expect(allText).not.toContain("OUTSIDE-MARKER");
  });
});
