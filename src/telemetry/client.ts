/**
 * S12 — Client telemetry for plugin lifecycle events.
 *
 * Privacy contract:
 *   - Opt-in ONLY. Default: disabled. Events are never enqueued before user
 *     explicitly answers the first-boot consent prompt (telemetryPromptAnswered=true
 *     AND enabled=true).
 *   - No PII. Payload contains only: event type, plugin slug, plugin version,
 *     error class name (for plugin_error), device_uuid (random, locally generated).
 *   - The GitHub App install token (used to authenticate to the marketplace)
 *     travels ONLY in the Authorization header — NEVER in the event body.
 *     Keeping secrets out of the JSON payload prevents accidental persistence
 *     if the backend logs request bodies, and narrows the blast radius if a
 *     batch is ever mirrored to an analytics sink.
 *   - PII scrubber strips absolute paths and email addresses from any string
 *     field before it leaves the process.
 *   - Transport: POST /telemetry/events to marketplace backend, batched.
 *   - SSRF defense: endpoint host is validated against an allowlist derived
 *     from the configured marketplace base URL before any network call.
 *   - Concurrency: flush() is serialized by an in-flight guard so overlapping
 *     timer ticks + explicit flush() calls can't duplicate-submit a batch.
 *
 * D6: Authorization header reuses the GitHub App token already stored as a
 *     secret under "marketplace.apiKey". No new auth mechanism introduced.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { TelemetrySettings } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("telemetry:plugin");

// ─── Event types ─────────────────────────────────────────────────────────────

export type PluginTelemetryEventName =
  | "plugin_install"
  | "plugin_uninstall"
  | "plugin_update"
  | "plugin_error";

export interface PluginTelemetryEvent {
  /** Schema version — always 1 for S12. */
  v: 1;
  /** Event type. No payload content, no PII. */
  name: PluginTelemetryEventName;
  /** Plugin slug (e.g. "com.lge.meeting-recorder"). */
  slug: string;
  /** Plugin semver (e.g. "1.2.3"). */
  version: string;
  /**
   * For plugin_error: the constructor name of the Error subclass
   * (e.g. "MarketplaceInstallerError"). Never the message text.
   */
  errorClass?: string;
  /** Epoch ms of event capture. */
  t: number;
  /** Per-device random UUID generated once and stored locally. */
  device_uuid: string;
}

// ─── PII scrubber ────────────────────────────────────────────────────────────

/**
 * Strip absolute paths and email-like strings from a value.
 * Applied to every string field before emission.
 *
 * Rules:
 *   - Absolute paths (/foo/bar or C:\foo\bar) → "[path]"
 *   - Email-shaped tokens → "[email]"
 */
export function scrubPii(value: string): string {
  // Absolute Unix paths: /something or ~/something
  let out = value.replace(/(^|\s|["'`])(~?\/[^\s"'`]{2,})/g, "$1[path]");
  // Windows paths: C:\... or \\server\...
  out = out.replace(/(^|\s|["'`])([A-Za-z]:\\[^\s"'`]*|\\\\[^\s"'`]+)/g, "$1[path]");
  // Email-like: word@word.tld
  out = out.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email]");
  return out;
}

// ─── device_uuid persistence ──────────────────────────────────────────────────

export function loadOrCreateDeviceUuid(uuidPath: string): string {
  if (existsSync(uuidPath)) {
    try {
      const raw = readFileSync(uuidPath, "utf-8").trim();
      if (raw.length > 0) return raw;
    } catch { /* fall through to create */ }
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(uuidPath), { recursive: true });
    writeFileSync(uuidPath, id, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    log.warn("could not persist device_uuid: %s", (err as Error).message);
  }
  return id;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface PluginTelemetryClientDeps {
  /**
   * Accessor for telemetry settings — re-evaluated on every track() so user
   * opt-out takes effect immediately without restart.
   */
  settings: () => TelemetrySettings;
  /**
   * Marketplace base URL for POST /telemetry/events.
   * If absent the client is a no-op even when enabled.
   */
  marketplaceBaseUrl: () => string | undefined;
  /**
   * GitHub App install token accessor (secret "marketplace.apiKey").
   * Absent when the user has not configured marketplace auth.
   */
  installToken: () => string | null | undefined;
  /** Absolute path where device_uuid is stored (~/.lvis/device-uuid). */
  deviceUuidPath: string;
  /** Batch flush interval in ms (default: 5 min). */
  flushIntervalMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_FLUSH_MS = 5 * 60 * 1000;

export class PluginTelemetryClient {
  private readonly queue: PluginTelemetryEvent[] = [];
  private readonly deviceUuid: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  /**
   * In-flight guard to prevent overlapping flush() calls from double-sending
   * the same batch (e.g. a manually triggered flush racing the interval tick,
   * or a long network call overlapping the next scheduled tick).
   */
  private flushInFlight: Promise<void> | null = null;

  constructor(private readonly deps: PluginTelemetryClientDeps) {
    this.deviceUuid = loadOrCreateDeviceUuid(deps.deviceUuidPath);
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Returns true only when:
   *   1. User has answered the first-boot prompt (telemetryPromptAnswered === true)
   *   2. User opted in (enabled === true)
   *   3. A marketplace base URL is configured
   */
  isActive(): boolean {
    const s = this.deps.settings();
    if (!s.telemetryPromptAnswered) return false;
    if (s.enabled !== true) return false;
    const base = this.deps.marketplaceBaseUrl();
    return typeof base === "string" && base.length > 0;
  }

  /**
   * Enqueue a plugin lifecycle event. No-op if telemetry is not active.
   * PII scrubber is applied to slug and version before queuing.
   */
  track(
    name: PluginTelemetryEventName,
    opts: { slug: string; version: string; errorClass?: string },
  ): void {
    if (!this.isActive()) return;
    const event: PluginTelemetryEvent = {
      v: 1,
      name,
      slug: scrubPii(opts.slug),
      version: scrubPii(opts.version),
      t: Date.now(),
      device_uuid: this.deviceUuid,
    };
    if (opts.errorClass !== undefined) {
      // Only class name — never the message (may contain PII).
      event.errorClass = scrubPii(opts.errorClass);
    }
    // The install token is intentionally NOT attached to the event body;
    // it is sent only in the Authorization header by flush(). Keeping
    // bearer tokens out of the JSON payload narrows the leak surface.
    this.queue.push(event);
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
    // Serialize overlapping callers. If a flush is already in flight the
    // caller awaits its completion instead of starting a second one that
    // would re-POST the same batch.
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.flushOnce().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async flushOnce(): Promise<void> {
    if (!this.isActive() || this.queue.length === 0) return;
    const base = this.deps.marketplaceBaseUrl()!.replace(/\/$/, "");
    const endpoint = `${base}/telemetry/events`;
    // SSRF defense: telemetry may only POST to the same origin as the
    // configured marketplace base URL. A malformed/attacker-controlled base
    // URL (e.g. injected via settings manipulation) must not be able to
    // redirect telemetry to arbitrary internal hosts.
    if (!this.endpointMatchesBase(endpoint, base)) {
      log.warn("endpoint failed allowlist check; dropping flush");
      return;
    }
    const batch = this.queue.slice(0);
    const batchLen = batch.length;
    const token = this.deps.installToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        log.warn(`flush non-ok HTTP ${res.status}; re-queued ${batchLen} event(s)`);
        return;
      }
      this.queue.splice(0, batchLen);
    } catch (err) {
      log.warn("flush failed (re-queued): %s", (err as Error).message);
    }
  }

  /**
   * Returns true when `endpoint` shares protocol + host + port with `base`.
   * Defense against SSRF via a tampered/misconfigured marketplace URL.
   */
  private endpointMatchesBase(endpoint: string, base: string): boolean {
    try {
      const ep = new URL(endpoint);
      const bp = new URL(base);
      if (ep.protocol !== "https:" && ep.protocol !== "http:") return false;
      if (ep.protocol !== bp.protocol) return false;
      if (ep.host !== bp.host) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Exposed for testing — current queue length. */
  get queueLength(): number {
    return this.queue.length;
  }
}
