/**
 * Q12 Phase 5 — HMAC chain for audit log tamper-evidence.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 7.
 *
 * Each audit line carries `prevHash = HMAC(secret, prevLine)` where
 * `prevLine` is the previous line's *exact JSON serialization* with
 * the trailing newline. The first line of a file uses the genesis
 * marker `"genesis"` so consumers can detect and skip it without a
 * stored "previous". Tampering with any line N forces the recomputed
 * prevHash at line N+1 to mismatch — exposing the tampered region.
 *
 * The HMAC secret lives in the system keychain when Electron's
 * `safeStorage` is available; otherwise it falls back to a 0o600
 * file at `~/.lvis/secrets/audit-hmac.key`. CLAUDE.md No-Fallback
 * rule covers external boundaries (OS keychain unavailability is
 * exactly that), so the file fallback is the *only* persistence
 * path — there is no in-memory-only mode.
 *
 * Daily seal: `sealDay(date)` walks the day's audit JSONL,
 * recomputes the chain, and writes the final hash to a separate
 * keychain entry `audit-seal-YYYY-MM-DD`. Forensics verify a day's
 * log is intact by recomputing the chain and matching the stored
 * seal.
 */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const GENESIS_MARKER = "genesis";

/**
 * Stable storage interface — abstracts keychain vs file persistence.
 * Tests inject a memory-backed impl.
 */
export interface SecretStore {
  /** Read a secret by name. Returns null when absent. */
  read(name: string): string | null;
  /** Write a secret by name. Throws on permission/IO errors. */
  write(name: string, value: string): void;
}

/**
 * File-backed store (`~/.lvis/secrets/`) — used when
 * Electron's `safeStorage` is unavailable. Each secret is a
 * single-line file with mode 0600.
 */
export class FileSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".lvis", "secrets");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private path(name: string): string {
    // Reject path-traversal characters to keep the keystore flat.
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, name);
  }

  read(name: string): string | null {
    const p = this.path(name);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8").replace(/\n$/, "");
  }

  write(name: string, value: string): void {
    const p = this.path(name);
    // Best-effort dir mode hardening — re-issue 0o700 each write so a
    // post-install perm change doesn't slowly drift open.
    if (existsSync(this.dir)) {
      try { chmodSync(this.dir, 0o700); } catch { /* non-fatal */ }
    }
    writeFileSync(p, value, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { /* non-fatal */ }
  }
}

/**
 * In-memory store — for tests. NOT a production fallback.
 */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  read(name: string): string | null {
    return this.map.has(name) ? this.map.get(name)! : null;
  }
  write(name: string, value: string): void {
    this.map.set(name, value);
  }
}

/**
 * Read or generate the audit HMAC secret. Idempotent — once
 * generated, subsequent calls return the same value.
 *
 * Throws if the store rejects the write (e.g. permission denied) —
 * caller (boot) treats this as fail-secure: refuse to start the
 * audit chain rather than silently downgrade to no-tamper-evidence.
 */
export function ensureAuditSecret(store: SecretStore): string {
  const name = "audit-hmac.key";
  const existing = store.read(name);
  if (existing && existing.length >= 32) {
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  store.write(name, generated);
  return generated;
}

/**
 * Compute the HMAC for a single line. Used both as the "prevHash"
 * value embedded in the next entry AND as the daily-seal final
 * hash.
 */
export function computeLineHmac(secret: string, line: string): string {
  return createHmac("sha256", secret).update(line).digest("hex");
}

/**
 * Verify a line's chain link given the *previous* serialized line
 * and the *current* entry's `prevHash`. Genesis line uses
 * `GENESIS_MARKER` as the previous-line stand-in.
 *
 * Constant-time comparison to defeat timing oracles on a determined
 * attacker who can observe verification latency.
 */
export function verifyLineHmac(
  secret: string,
  previousLine: string,
  expectedPrevHash: string,
): boolean {
  const computed = computeLineHmac(secret, previousLine);
  if (computed.length !== expectedPrevHash.length) return false;
  return timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(expectedPrevHash, "hex"),
  );
}

/**
 * Build the chain — given a list of input objects (already shaped
 * as Q12 entries minus `prevHash`), return the same objects with
 * `prevHash` populated. The first entry's `prevHash` is the
 * genesis-marker HMAC.
 *
 * Used by `audit-logger`'s `appendQ12Entry` and by tests that need
 * to construct a known-good fixture.
 */
export function buildChainedEntries<T extends Record<string, unknown>>(
  secret: string,
  entries: T[],
): Array<T & { prevHash: string }> {
  const out: Array<T & { prevHash: string }> = [];
  let prevSerialized = GENESIS_MARKER;
  for (const e of entries) {
    const withHash = { ...e, prevHash: computeLineHmac(secret, prevSerialized) };
    out.push(withHash as T & { prevHash: string });
    // The *next* entry's prevHash is computed over the SERIALIZED
    // form of this entry — i.e. the JSON.stringify output that
    // ends up on disk.
    prevSerialized = JSON.stringify(withHash);
  }
  return out;
}

/**
 * Verify a complete chain. Returns the index of the FIRST broken
 * line (0-indexed) or null when the chain is intact.
 *
 * The check runs in two stages per line:
 *   1. The line itself must parse as JSON.
 *   2. Its `prevHash` must equal HMAC(secret, previousLineSerialized).
 *
 * On the first line `previousLineSerialized = GENESIS_MARKER`.
 */
export function verifyChain(
  secret: string,
  lines: string[],
): { ok: true } | { ok: false; firstBrokenLineIndex: number; reason: string } {
  let prevSerialized = GENESIS_MARKER;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let parsed: { prevHash?: unknown };
    try {
      parsed = JSON.parse(raw) as { prevHash?: unknown };
    } catch {
      return { ok: false, firstBrokenLineIndex: i, reason: "json-parse-error" };
    }
    if (typeof parsed.prevHash !== "string") {
      return { ok: false, firstBrokenLineIndex: i, reason: "missing-prevHash" };
    }
    if (!verifyLineHmac(secret, prevSerialized, parsed.prevHash)) {
      return { ok: false, firstBrokenLineIndex: i, reason: "hmac-mismatch" };
    }
    prevSerialized = raw;
  }
  return { ok: true };
}

/**
 * Compute the daily seal — HMAC over the *last serialized line* of
 * a day's chain. Forensics store this in the keychain (separate
 * from the chain itself, so a tampered file doesn't get a fresh
 * matching seal).
 */
export function computeDailySeal(secret: string, lastLine: string): string {
  return computeLineHmac(secret, lastLine);
}

/**
 * Helper — the keychain entry name for a date's seal.
 *
 *   sealKeyName("2026-05-09") === "audit-seal-2026-05-09"
 */
export function sealKeyName(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`invalid ISO date for seal name: ${isoDate}`);
  }
  return `audit-seal-${isoDate}`;
}

/**
 * Walk the file's lines, compute the seal, persist to the secret
 * store. Returns the computed seal hash. No-op (returns null)
 * when the file does not exist or contains no entries.
 */
export function sealDayFromFile(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const seal = computeDailySeal(secret, lines[lines.length - 1]);
  store.write(sealKeyName(isoDate), seal);
  return seal;
}

/**
 * Verify a day's seal — compute the chain, then compute the seal
 * from the last line, and compare against the stored seal.
 *
 * Returns:
 *   { ok: true }                                 — chain intact, seal matches
 *   { ok: false, reason: "no-seal" }            — no stored seal for the day
 *   { ok: false, reason: "chain-broken", index } — chain check failed
 *   { ok: false, reason: "seal-mismatch" }       — chain ok but seal differs
 */
export function verifyDailySeal(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
):
  | { ok: true }
  | { ok: false; reason: "no-seal" }
  | { ok: false; reason: "chain-broken"; firstBrokenLineIndex: number }
  | { ok: false; reason: "seal-mismatch" }
  | { ok: false; reason: "no-file" } {
  if (!existsSync(filePath)) return { ok: false, reason: "no-file" };
  const stored = store.read(sealKeyName(isoDate));
  if (!stored) return { ok: false, reason: "no-seal" };
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const chain = verifyChain(secret, lines);
  if (!chain.ok) {
    return {
      ok: false,
      reason: "chain-broken",
      firstBrokenLineIndex: chain.firstBrokenLineIndex,
    };
  }
  const computed = computeDailySeal(secret, lines[lines.length - 1]);
  if (computed.length !== stored.length) return { ok: false, reason: "seal-mismatch" };
  const same = timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(stored, "hex"),
  );
  return same ? { ok: true } : { ok: false, reason: "seal-mismatch" };
}

/**
 * Extract a Q12-only line subset — the audit log file mixes legacy
 * telemetry entries (with `type` field) and Q12 entries (with
 * `decision` field). Chain verification only cares about the Q12
 * subset; this helper filters them out.
 *
 * Note: in the v1 implementation Q12 entries are written to a
 * dedicated file (`<date>.q12.jsonl`) so this helper is unused
 * in the hot path. Kept exported for forensic tooling that walks
 * legacy mixed files.
 */
export function filterQ12Lines(lines: string[]): string[] {
  return lines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      return typeof parsed.decision === "string" && typeof parsed.auditId === "string";
    } catch {
      return false;
    }
  });
}

/**
 * Make sure the parent directory of a path exists with mode 0o700.
 * Used by the audit-logger when bootstrapping a fresh `.lvis/audit/`.
 */
export function ensureSecureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
