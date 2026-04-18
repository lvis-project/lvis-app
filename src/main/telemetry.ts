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
}

const DEFAULT_FLUSH_MS = 24 * 60 * 60 * 1000;

export class TelemetryService {
  private readonly queue: TelemetryEvent[] = [];
  private readonly sid: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TelemetryDeps) {
    this.sid = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  }

  private currentSettings(): TelemetrySettings {
    return this.deps.settings();
  }

  isActive(): boolean {
    const s = this.currentSettings();
    return (
      s.enabled === true &&
      typeof s.endpoint === "string" &&
      s.endpoint.length > 0
    );
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
