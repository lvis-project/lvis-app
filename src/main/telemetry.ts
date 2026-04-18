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
  settings: TelemetrySettings;
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

  isActive(): boolean {
    return (
      this.deps.settings.enabled === true &&
      typeof this.deps.settings.endpoint === "string" &&
      this.deps.settings.endpoint.length > 0
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
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.fetchImpl(this.deps.settings.endpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
    } catch (err) {
      console.warn("[telemetry] flush failed:", (err as Error).message);
    }
  }
}
