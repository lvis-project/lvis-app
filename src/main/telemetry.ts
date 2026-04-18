/**
 * Production release prep — anonymous opt-in telemetry.
 *
 * Privacy contract:
 *   - No PII. Only event name + numeric duration/count + hashed session UUID.
 *   - Default OFF. Must be explicitly enabled via settings UI.
 *   - Transport: HTTP POST, batched daily (or on flush()).
 *   - Endpoint configurable per-install (self-hosted friendly).
 */
import { randomUUID, createHash } from "node:crypto";
import type { TelemetrySettings } from "../data/settings-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";

/**
 * Default host allowlist for the telemetry endpoint. Can be overridden via
 * the LVIS_TELEMETRY_ALLOWLIST env var (comma-separated hostnames).
 *
 * `localhost` is only honored in non-packaged (dev) builds; isPackaged check
 * in validateEndpoint() rejects it when app.isPackaged === true.
 */
export const DEFAULT_TELEMETRY_ALLOWLIST: readonly string[] = [
  "telemetry.lge.com",
  "localhost",
];

function parseAllowlist(envVal: string | undefined): string[] {
  if (!envVal) return [...DEFAULT_TELEMETRY_ALLOWLIST];
  return envVal
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export interface EndpointValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a telemetry endpoint URL.
 *   - protocol MUST be https: (rejects http:, file:, data:, javascript:)
 *   - host MUST be in allowlist
 *   - localhost is rejected in packaged builds
 */
export function validateTelemetryEndpoint(
  endpoint: string | undefined,
  opts: { isPackaged: boolean; allowlistEnv?: string },
): EndpointValidationResult {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { valid: false, reason: "endpoint missing" };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { valid: false, reason: "endpoint not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { valid: false, reason: `protocol '${url.protocol}' not allowed (https: required)` };
  }
  const host = url.hostname.toLowerCase();
  const allowlist = parseAllowlist(opts.allowlistEnv);
  if (!allowlist.includes(host)) {
    return { valid: false, reason: `host '${host}' not in telemetry allowlist` };
  }
  if (host === "localhost" && opts.isPackaged) {
    return { valid: false, reason: "localhost endpoint rejected in packaged build" };
  }
  return { valid: true };
}

export type TelemetryEventName =
  | "app_start"
  | "chat_turn"
  | "tool_call"
  | "plugin_load"
  | "crash";

export interface TelemetryEvent {
  v: 1;
  name: TelemetryEventName;
  sid: string;
  t: number;
  durMs?: number;
  count?: number;
  appVersion?: string;
}

export interface TelemetryDeps {
  /**
   * Settings accessor — invoked on every track()/flush() so a user toggle
   * takes effect immediately. A snapshot object would go stale and keep
   * accepting events after the user opted out.
   */
  settings: () => TelemetrySettings;
  appVersion?: string;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  /** M2: when true, localhost endpoints are rejected. Pass app.isPackaged. */
  isPackaged?: boolean;
  /** M2: optional audit sink for endpoint rejections. */
  auditLogger?: Pick<AuditLogger, "log">;
  /** M2: override env for host allowlist — tests pass explicit string. */
  allowlistEnv?: string;
}

const DEFAULT_FLUSH_MS = 24 * 60 * 60 * 1000;

export class TelemetryService {
  private readonly queue: TelemetryEvent[] = [];
  private readonly sid: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  /** M2: once an invalid endpoint is seen, disable for the session (no retry). */
  private sessionDisabled = false;

  constructor(private readonly deps: TelemetryDeps) {
    this.sid = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  }

  private currentSettings(): TelemetrySettings {
    return this.deps.settings();
  }

  /**
   * M2: validate the configured endpoint. On first invalid endpoint, emit an
   * audit warn and mark session-disabled so no further retries/traffic occur.
   * Returns true when the endpoint is safe to use.
   */
  private endpointAllowed(endpoint: string | undefined): boolean {
    if (this.sessionDisabled) return false;
    const result = validateTelemetryEndpoint(endpoint, {
      isPackaged: this.deps.isPackaged ?? false,
      allowlistEnv: this.deps.allowlistEnv ?? process.env.LVIS_TELEMETRY_ALLOWLIST,
    });
    if (!result.valid) {
      this.sessionDisabled = true;
      try {
        this.deps.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "telemetry",
          type: "error",
          input: `[telemetry] endpoint rejected: ${result.reason}`,
          output: typeof endpoint === "string" ? endpoint.slice(0, 200) : undefined,
        });
      } catch {
        // audit failure must not break app
      }
      console.warn(`[telemetry] endpoint rejected (${result.reason}) — disabling for session`);
      return false;
    }
    return true;
  }

  isActive(): boolean {
    if (this.sessionDisabled) return false;
    const s = this.currentSettings();
    if (s.enabled !== true) return false;
    return this.endpointAllowed(s.endpoint);
  }

  track(name: TelemetryEventName, extra: { durMs?: number; count?: number } = {}): void {
    if (!this.isActive()) return;
    const ev: TelemetryEvent = {
      v: 1,
      name,
      sid: this.sid,
      t: Date.now(),
      appVersion: this.deps.appVersion,
      ...extra,
    };
    this.queue.push(ev);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    if (!this.isActive() || this.queue.length === 0) return;
    // Snapshot the batch but DO NOT dequeue until after a confirmed 2xx. On
    // error or non-ok HTTP we leave events in the queue so they retry on the
    // next flush instead of being silently lost.
    const batch = this.queue.slice(0);
    const batchLen = batch.length;
    const endpoint = this.currentSettings().endpoint!;
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        console.warn(`[telemetry] flush non-ok HTTP ${res.status}; re-queued ${batchLen} event(s)`);
        return;
      }
      this.queue.splice(0, batchLen);
    } catch (err) {
      console.warn("[telemetry] flush failed (re-queued):", (err as Error).message);
    }
  }
}
