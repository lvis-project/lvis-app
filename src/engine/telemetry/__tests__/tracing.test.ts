/**
 * Tracing wiring: the spec grammar, the file sink's line shape, and the
 * default-off tracer.
 *
 * The spec grammar matters because a misspelled `LVIS_TELEMETRY` that parsed
 * as "off" would be indistinguishable from a run nobody configured, and a
 * benchmark would report a clean run with no trace behind it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildMainBoundaryBundle,
  childBundleDir,
  repositoryRoot,
} from "../../../plugins/isolation/__tests__/child-entry-bundle.js";

import {
  configureTracing,
  decisionAttributes,
  parseTelemetrySpec,
  TURN_SPAN_NAME,
} from "../tracing.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-tracing-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseTelemetrySpec", () => {
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["off", "off"],
  ])("treats %s as off", (_label, raw) => {
    expect(parseTelemetrySpec(raw)).toEqual({ kind: "off" });
  });

  it("accepts an OTLP http(s) collector and normalizes the URL", () => {
    expect(parseTelemetrySpec("otlp:http://127.0.0.1:4318/v1/traces")).toEqual({
      kind: "otlp",
      url: "http://127.0.0.1:4318/v1/traces",
    });
  });

  it("accepts a file sink and keeps the path verbatim", () => {
    expect(parseTelemetrySpec("file:/var/log/lvis/spans.jsonl")).toEqual({
      kind: "file",
      path: "/var/log/lvis/spans.jsonl",
    });
  });

  it.each([
    ["a sink with no separator", "otlp"],
    ["an unknown sink", "syslog:/dev/log"],
    ["an empty target", "file:"],
    ["a non-URL otlp target", "otlp:not a url"],
    ["a non-http otlp scheme", "otlp:file:///tmp/spans"],
  ])("reports %s as an error rather than silently disabling", (_label, raw) => {
    const spec = parseTelemetrySpec(raw);
    expect(spec).toHaveProperty("error");
    expect((spec as { error: string }).error).toContain("LVIS_TELEMETRY");
  });
});

describe("decisionAttributes", () => {
  it("flattens kind, branch, reason and data under one prefix", () => {
    expect(decisionAttributes({
      kind: "length.continuation",
      branch: "stop",
      reason: "cap",
      data: { continuationsRun: 3, cap: 3, carryTextChars: 120 },
    })).toEqual({
      "lvis.decision.kind": "length.continuation",
      "lvis.decision.branch": "stop",
      "lvis.decision.reason": "cap",
      "lvis.decision.data.continuationsRun": 3,
      "lvis.decision.data.cap": 3,
      "lvis.decision.data.carryTextChars": 120,
    });
  });

  it("omits an absent reason instead of writing an empty one", () => {
    expect(decisionAttributes({ kind: "tool_batch", branch: "single" })).toEqual({
      "lvis.decision.kind": "tool_batch",
      "lvis.decision.branch": "single",
    });
  });
});

describe("configureTracing", () => {
  it("registers nothing when tracing is off and hands back a non-recording tracer", async () => {
    const handle = await configureTracing({ kind: "off" }, "0.0.0-test");

    expect(handle.enabled).toBe(false);
    const span = handle.tracer.startSpan(TURN_SPAN_NAME);
    expect(span.isRecording()).toBe(false);
    span.end();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("treats a malformed spec as off rather than throwing at the caller", async () => {
    const handle = await configureTracing({ error: "bad spec" }, "0.0.0-test");

    expect(handle.enabled).toBe(false);
    await handle.shutdown();
  });

  it("writes one JSON line per finished span to the file sink", async () => {
    const path = join(tempDir(), "spans.jsonl");
    const handle = await configureTracing({ kind: "file", path }, "9.9.9-test");
    expect(handle.enabled).toBe(true);

    const span = handle.tracer.startSpan(TURN_SPAN_NAME, {
      attributes: { "lvis.session_id": "session-under-test" },
    });
    span.addEvent("lvis.decision", { "lvis.decision.kind": "early_exit" });
    span.end();
    await handle.shutdown();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]) as {
      name: string;
      traceId: string;
      spanId: string;
      durationMs: number;
      attributes: Record<string, unknown>;
      events: Array<{ name: string; attributes: Record<string, unknown> }>;
    };
    expect(written.name).toBe(TURN_SPAN_NAME);
    expect(written.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(written.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(written.durationMs).toBeGreaterThanOrEqual(0);
    expect(written.attributes["lvis.session_id"]).toBe("session-under-test");
    expect(written.events).toEqual([
      expect.objectContaining({
        name: "lvis.decision",
        attributes: { "lvis.decision.kind": "early_exit" },
      }),
    ]);
  });
});

/**
 * The shipped main bundle is a split ESM build, and a split chunk that wraps a
 * CommonJS dependency exposes only `default`. The OpenTelemetry SDK ships as
 * CommonJS, so `configureTracing` is exercised here through that exact boundary
 * rather than through vitest's own loader, which resolves the packages natively
 * and would pass while the packaged app throws at boot.
 */
describe("configureTracing through the shipped bundle boundary", () => {
  const bundleDir = childBundleDir("tracing-bundle");
  let bundled: typeof import("../tracing.js");

  beforeAll(async () => {
    await buildMainBoundaryBundle({
      entryPoints: { tracing: join(repositoryRoot(), "src/engine/telemetry/tracing.ts") },
      outdir: bundleDir,
      splitting: true,
    });
    // The premise: the lazy `import()`s became split chunks. A static import
    // would inline the SDK and this suite would prove nothing about the chunk.
    expect(readdirSync(join(bundleDir, "chunks")).length).toBeGreaterThan(0);
    bundled = (await import(
      pathToFileURL(join(bundleDir, "tracing.mjs")).href
    )) as typeof import("../tracing.js");
  });

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("resolves the OpenTelemetry SDK from a split ESM chunk and writes a span", async () => {
    const path = join(tempDir(), "spans.jsonl");
    const handle = await bundled.configureTracing({ kind: "file", path }, "9.9.9-bundle");
    expect(handle.enabled).toBe(true);
    handle.tracer.startSpan("bundle-probe").end();
    await handle.shutdown();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { name: string }).name).toBe("bundle-probe");
  });

  it("constructs the OTLP exporter from its chunk", async () => {
    // No collector is contacted: constructing the exporter is where a
    // `default`-only chunk fails, and shutdown flushes nothing.
    const handle = await bundled.configureTracing(
      { kind: "otlp", url: "http://127.0.0.1:9/v1/traces" },
      "9.9.9-bundle",
    );
    expect(handle.enabled).toBe(true);
    await handle.shutdown();
  });
});
