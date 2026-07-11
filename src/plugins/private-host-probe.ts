/**
 * `probePrivateHost` — does the OS resolver know about a host that only exists
 * on a private network (corporate intranet, VPN, lab subnet)?
 *
 * Host-side landing of the SDK's `runtime/network.ts#detectViaPrivateDnsProbe`
 * shim: the capability moves INTO hostApi so plugins never reach `dns.lookup`
 * (or a corp-network presence probe) directly. The core mechanism is ported
 * faithfully; the host adds argument validation + timeout clamping.
 *
 * Mechanism: `node:dns/promises.lookup(host)` raced against a `Promise.race`
 * deadline. On-corp DNS resolves the host (typically an RFC1918 private IP);
 * off-corp DNS returns `ENOTFOUND`. The async asymmetry is the signal.
 *
 * Design decisions (unchanged from the SDK shim):
 *   - No result cache. corp↔off-corp transitions in both directions are common
 *     (VPN connect/disconnect, leaving the office); a sticky cache defeats the
 *     gate in one direction. The OS DNS cache handles perf (≤1ms hit).
 *   - `inFlight` dedup keyed by host. The entry's lifetime is tied to the
 *     UNDERLYING `dns.lookup` settling, not the timeout-race outcome — otherwise
 *     a timeout-winning race releases the dedup slot while libuv's getaddrinfo
 *     is still running, and retry-loop callers fan out to concurrent lookups
 *     against slow DNS. While a lookup is in flight, subsequent callers receive
 *     the SAME race outcome; fresh probes can only start after it settles.
 *   - Fail-safe to `false` on timeout. A slow user gate is worse than a
 *     false-negative under slow corp DNS.
 *   - The deadline timer is `unref`'d so it never keeps the event loop alive
 *     past app exit.
 *
 * This is a UX HINT, NOT a trust boundary. A local DNS spoof or split-DNS
 * environment can return `true` from an attacker-controlled probe. Plugins MUST
 * enforce real trust at the cookie/origin level downstream — never treat a
 * `true` here as authorization.
 */
import { lookup } from "node:dns/promises";

export interface ProbePrivateHostOptions {
  /** Race deadline before falling through to `false`. Default 1500ms, clamped. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
/** Host-side clamp — a caller can neither hang the gate forever nor busy-spin it. */
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

/**
 * Reject anything that is not a bare hostname: whitespace, a scheme/port `:`,
 * a path/backslash, userinfo `@`, or query/hash markers. A URL or `host:port`
 * must not reach `dns.lookup`.
 */
const NON_BARE_HOSTNAME = /[\s/:@?#\\]/;

const inFlightByHost = new Map<string, Promise<boolean>>();

export async function probePrivateHost(
  host: string,
  opts: ProbePrivateHostOptions = {},
): Promise<boolean> {
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new TypeError(
      `probePrivateHost: host must be a non-empty string (got ${
        typeof host === "string" ? "empty/whitespace string" : typeof host
      })`,
    );
  }
  if (NON_BARE_HOSTNAME.test(host)) {
    throw new TypeError(
      "probePrivateHost: host must be a bare hostname (no scheme, port, path, userinfo, or whitespace)",
    );
  }

  // Clamp to sane bounds; fall back to the default for NaN / non-number /
  // non-positive input (a malformed timeout must never throw or hang).
  const raw = opts.timeoutMs;
  const timeoutMs =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  // Same-host dedup. The inflight entry's lifetime is bound to the underlying
  // lookup, not the race outcome (see header).
  const existing = inFlightByHost.get(host);
  if (existing) return existing;

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Wrap the lookup in `Promise.resolve().then(...)` so a synchronous throw from
  // `lookup(...)` (mock-fed garbage, future Node prevalidation) lands in the
  // `.catch(() => false)` instead of escaping past the dedup setup.
  const lookupPromise = Promise.resolve()
    .then(() => lookup(host))
    .then(() => true)
    .catch(() => false);

  const probe = (async () => {
    try {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        // unref — the timer must not keep the event loop alive past app exit.
        timer.unref();
      });
      return await Promise.race([lookupPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  // ORDER MATTERS: register the dedup entry BEFORE attaching the lifetime
  // cleanup, so a synchronously-settled `lookupPromise` (test mock) does not
  // strand the slot — the `.finally` callback runs after this `set`.
  inFlightByHost.set(host, probe);
  void lookupPromise.finally(() => {
    inFlightByHost.delete(host);
  });

  return probe;
}

/** @internal Test only — clears the same-host in-flight dedup map. */
export function __resetPrivateHostProbeInFlightForTests(): void {
  inFlightByHost.clear();
}
