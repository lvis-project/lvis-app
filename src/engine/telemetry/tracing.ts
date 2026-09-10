/**
 * OpenTelemetry wiring for the conversation runtime.
 *
 * Observability is its own domain boundary: the loop decides what happened,
 * this unit decides where the record of it goes. Keeping the provider, the
 * exporter and the span vocabulary here is what lets `run-turn.ts` and
 * `query-loop.ts` stay free of SDK types — they see a `Tracer` and nothing
 * else, and when tracing is off they see the API's no-op tracer.
 *
 * The OTel SDK and the AI SDK integration are reached through dynamic import
 * so an unconfigured run never evaluates them: default-off has to be free,
 * not merely inert.
 */
import { trace, type Tracer } from "@opentelemetry/api";
import { appendFileSync } from "node:fs";
import { createLogger } from "../../lib/logger.js";
import type { TurnDecisionEvent } from "../turn/types.js";

const log = createLogger("lvis");

/** The span a whole conversation turn opens; AI SDK spans nest under it. */
export const TURN_SPAN_NAME = "lvis.turn";
/** Prefix of the per-tool-call child span, completed with the tool name. */
export const TOOL_SPAN_PREFIX = "execute_tool ";
/** Span event carrying one {@link TurnDecisionEvent}. */
export const DECISION_EVENT_NAME = "lvis.decision";

/** Where finished spans go. `off` registers no provider at all. */
export type TelemetrySpec =
  | { kind: "off" }
  | { kind: "otlp"; url: string }
  | { kind: "file"; path: string }
  | { error: string };

export interface TracingHandle {
  readonly tracer: Tracer;
  readonly enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Parse `LVIS_TELEMETRY`. Unset, empty and `off` all mean off; anything else
 * must name a sink, because a misspelled spec that silently traced nothing
 * would be indistinguishable from a run that was never configured.
 */
export function parseTelemetrySpec(raw: string | undefined): TelemetrySpec {
  const value = raw?.trim() ?? "";
  if (value.length === 0 || value === "off") return { kind: "off" };
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { error: `LVIS_TELEMETRY must be "off", "otlp:<url>" or "file:<path>", got "${value}"` };
  }
  const kind = value.slice(0, separator);
  const target = value.slice(separator + 1).trim();
  if (target.length === 0) {
    return { error: `LVIS_TELEMETRY "${kind}" needs a target, got "${value}"` };
  }
  if (kind === "otlp") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { error: `LVIS_TELEMETRY otlp target is not a URL: "${target}"` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: `LVIS_TELEMETRY otlp target must be http(s), got "${url.protocol}"` };
    }
    return { kind: "otlp", url: url.toString() };
  }
  if (kind === "file") return { kind: "file", path: target };
  return { error: `LVIS_TELEMETRY sink must be "otlp" or "file", got "${kind}"` };
}

/** Flatten a decision onto span-attribute keys shared by producer and tests. */
export function decisionAttributes(
  event: TurnDecisionEvent,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "lvis.decision.kind": event.kind,
    "lvis.decision.branch": event.branch,
  };
  if (event.reason !== undefined) attributes["lvis.decision.reason"] = event.reason;
  for (const [key, value] of Object.entries(event.data ?? {})) {
    attributes[`lvis.decision.data.${key}`] = value;
  }
  return attributes;
}

/** One finished span, as the file sink writes it. */
interface ExportedSpanLine {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timeMs: number; attributes: Record<string, unknown> }>;
  status: { code: number; message?: string };
}

function hrTimeToMs(time: readonly [number, number]): number {
  return time[0] * 1e3 + time[1] / 1e6;
}

/**
 * Append-only JSON-lines exporter.
 *
 * It lives here rather than in its own file because the tracing spec is the
 * only thing that can select it and nothing else can construct one; a separate
 * module would be a second place to keep the line shape in step with the
 * benchmark reader.
 */
function createFileSpanExporter(path: string): {
  export(spans: readonly unknown[], done: (result: { code: number; error?: Error }) => void): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
} {
  const writeSpans = (spans: readonly unknown[]): void => {
    if (spans.length === 0) return;
    const lines = spans
      .map((raw) => {
        const span = raw as {
          spanContext(): { traceId: string; spanId: string };
          parentSpanContext?: { spanId: string };
          name: string;
          kind: number;
          startTime: readonly [number, number];
          endTime: readonly [number, number];
          duration: readonly [number, number];
          attributes: Record<string, unknown>;
          events: ReadonlyArray<{
            name: string;
            time: readonly [number, number];
            attributes?: Record<string, unknown>;
          }>;
          status: { code: number; message?: string };
        };
        const context = span.spanContext();
        const line: ExportedSpanLine = {
          traceId: context.traceId,
          spanId: context.spanId,
          ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeMs: hrTimeToMs(span.startTime),
          endTimeMs: hrTimeToMs(span.endTime),
          durationMs: hrTimeToMs(span.duration),
          attributes: span.attributes,
          events: span.events.map((event) => ({
            name: event.name,
            timeMs: hrTimeToMs(event.time),
            attributes: event.attributes ?? {},
          })),
          status: span.status,
        };
        return JSON.stringify(line);
      })
      .join("\n");
    appendFileSync(path, `${lines}\n`, { mode: 0o600 });
  };

  return {
    export(spans, done) {
      try {
        writeSpans(spans);
        done({ code: 0 });
      } catch (err) {
        done({ code: 1, error: err as Error });
      }
    },
    async shutdown() {
      // Nothing is buffered here: every batch is written synchronously as it
      // arrives, so the processor's own flush is the only thing to wait on.
    },
    async forceFlush() {},
  };
}

function offHandle(): TracingHandle {
  return {
    tracer: trace.getTracer("lvis"),
    enabled: false,
    async forceFlush() {},
    async shutdown() {},
  };
}

/**
 * Register a tracer provider for `spec` and hand the AI SDK the same tracer.
 *
 * `provider.register()` also installs the AsyncLocalStorage context manager,
 * which is what makes the AI SDK's `invoke_agent` / `step` / `chat` spans land
 * under the turn span instead of at the root.
 */
export async function configureTracing(
  spec: TelemetrySpec,
  appVersion: string,
): Promise<TracingHandle> {
  if ("error" in spec || spec.kind === "off") return offHandle();

  const [{ BatchSpanProcessor, NodeTracerProvider }, { resourceFromAttributes }] =
    await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/resources"),
    ]);
  const exporter = spec.kind === "file"
    ? createFileSpanExporter(spec.path)
    : new (await import("@opentelemetry/exporter-trace-otlp-http")).OTLPTraceExporter({
        url: spec.url,
      });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "lvis",
      "service.version": appVersion,
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        exporter as ConstructorParameters<typeof BatchSpanProcessor>[0],
      ),
    ],
  });
  provider.register();

  const tracer = provider.getTracer("lvis");
  const [{ registerTelemetry }, { OpenTelemetry }] = await Promise.all([
    import("ai"),
    import("@ai-sdk/otel"),
  ]);
  registerTelemetry(new OpenTelemetry({ tracer, usage: true }));
  log.info(`telemetry: tracing to ${spec.kind === "file" ? spec.path : spec.url}`);

  return {
    tracer,
    enabled: true,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}
