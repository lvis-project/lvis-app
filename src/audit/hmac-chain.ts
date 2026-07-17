/**
 * HMAC chain for audit log tamper-evidence.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7.
 *
 * Each audit line carries `prevHash = HMAC(secret, prevLine)` where
 * `prevLine` is the previous line's exact raw JSON string as stored in the
 * JSONL body, without the trailing newline. The first line of a file uses
 * `HMAC(secret, GENESIS_MARKER)` where `GENESIS_MARKER = "genesis"`.
 * Tampering with any line N forces the recomputed
 * prevHash at line N+1 to mismatch — exposing the tampered region.
 *
 * The HMAC secret lives behind Electron's OS-backed `safeStorage`
 * when encryption is available. On platforms where that external OS
 * facility is unavailable, the app uses a 0o600 file at
 * `~/.lvis/secrets/audit-hmac.key`. There is no in-memory-only mode.
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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";
import { lvisHome } from "../shared/lvis-home.js";

export const GENESIS_MARKER = "genesis";
const AUDIT_HMAC_SECRET_NAME = "audit-hmac.key";
const SAFE_STORAGE_SECRET_PREFIX = "safe:v1:";
const DEFAULT_SECRET_READ_MAX_BYTES = 1024 * 1024;
const MAX_SECRET_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_STORAGE_FILE_BYTES = 32 * 1024 * 1024;
const SECRET_AUTHORITY_MAX_BYTES = 4 * 1024;

function hardenSecretDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") chmodSync(dir, 0o700);
}

function fsyncDirectory(dir: string): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic temp -> fsync -> rename -> directory-fsync secret replacement. */
function atomicWriteSecretFile(dir: string, path: string, value: string): void {
  hardenSecretDirectory(dir);
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, value, { encoding: "utf-8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (platform !== "win32") chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    if (platform !== "win32") chmodSync(path, 0o600);
    fsyncDirectory(dir);
  } catch (cause) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary failure */ }
    }
    try { unlinkSync(tempPath); } catch { /* absent or already renamed */ }
    throw cause;
  }
}

function assertSecretReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > MAX_SECRET_READ_LIMIT_BYTES) {
    throw new TypeError("secret read byte limit is invalid");
  }
}

function assertStoredSecretReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > MAX_SAFE_STORAGE_FILE_BYTES) {
    throw new TypeError("stored secret read byte limit is invalid");
  }
}

function sameSecretFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readSecretFileUtf8Bounded(
  filePath: string,
  maxStoredBytes: number,
): string | null {
  assertStoredSecretReadLimit(maxStoredBytes);
  const flags = constants.O_RDONLY |
    (platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    const before = fstatSync(fd, { bigint: true });
    const pathAtOpen = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || pathAtOpen.isSymbolicLink() ||
        !pathAtOpen.isFile() || !sameSecretFileIdentity(pathAtOpen, before)) {
      throw new Error("secret authority path is not a stable regular file");
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxStoredBytes) {
      throw new Error("secret authority exceeds read byte limit");
    }
    const buffer = Buffer.alloc(size);
    let completed = 0;
    while (completed < size) {
      const read = readSync(fd, buffer, completed, size - completed, completed);
      if (read === 0) {
        throw new Error("secret authority was truncated during read");
      }
      completed += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameSecretFileIdentity(before, after) ||
        !sameSecretFileIdentity(after, pathAfter) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) {
      throw new Error("secret authority changed during read");
    }
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new Error("secret authority is not valid UTF-8");
    }
    return text.replace(/\n$/, "");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSecretValueWithinLimit(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("secret authority value exceeds read byte limit");
  }
}

function safeStorageFileLimit(maxValueBytes: number): number {
  return Math.min(
    MAX_SAFE_STORAGE_FILE_BYTES,
    maxValueBytes * 16 + 4 * 1024,
  );
}

/**
 * Stable storage interface — abstracts keychain vs file persistence.
 * Tests inject a memory-backed impl.
 */
export interface SecretStore {
  /** Read at most maxBytes of decoded UTF-8 value. Returns null when absent. */
  read(name: string, maxBytes: number): string | null;
  /** Write a secret by name. Throws on permission/IO errors. */
  write(name: string, value: string): void;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/**
 * File-backed store (`~/.lvis/secrets/`) — used when
 * Electron's `safeStorage` is unavailable. Each secret is a
 * single-line file with mode 0600.
 */
export class FileSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(lvisHome(), "secrets");
    hardenSecretDirectory(this.dir);
  }

  private path(name: string): string {
    // Reject path-traversal characters to keep the keystore flat.
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, name);
  }

  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    assertSecretReadLimit(maxBytes);
    const p = this.path(name);
    const value = readSecretFileUtf8Bounded(p, maxBytes + 1);
    if (value === null) return null;
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
  }

  write(name: string, value: string): void {
    const p = this.path(name);
    atomicWriteSecretFile(this.dir, p, value);
  }
}

/**
 * Electron safeStorage-backed secret store. Ciphertext is persisted under
 * `~/.lvis/secrets/` with 0600 mode; the secret material is encrypted by
 * the OS-backed Electron safeStorage facility before it touches disk.
 */
export class SafeStorageSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    dir?: string,
  ) {
    this.dir = dir ?? join(lvisHome(), "secrets");
    hardenSecretDirectory(this.dir);
  }

  private path(name: string): string {
    if (/[\/\\]|\.\./.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
    return join(this.dir, `${name}.safe-storage`);
  }

  private assertAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is not available");
    }
  }

  private quarantinePath(path: string, createdAt: string): string {
    const stamp = createdAt.replace(/[:.]/g, "-");
    for (let i = 0; i < 100; i++) {
      const suffix = i === 0 ? "" : `-${i}`;
      const candidate = `${path}.quarantined-${stamp}${suffix}`;
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error(`could not allocate quarantine path for ${path}`);
  }

  private quarantineUnreadableSecret(
    name: string,
    path: string,
    reason: "invalid-prefix" | "decrypt-failed",
    cause?: unknown,
  ): void {
    const createdAt = new Date().toISOString();
    const quarantinedPath = this.quarantinePath(path, createdAt);
    renameSync(path, quarantinedPath);
    try { chmodSync(quarantinedPath, 0o600); } catch { /* non-fatal */ }

    const marker = {
      schemaVersion: 1,
      type: "safe-storage-secret-quarantined",
      secretName: name,
      reason,
      createdAt,
      originalPath: path,
      quarantinedPath,
      cause: cause instanceof Error ? cause.message : undefined,
    };
    try {
      const markerPath = `${path}.recovery-${createdAt.replace(/[:.]/g, "-")}.json`;
      writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      try { chmodSync(markerPath, 0o600); } catch { /* non-fatal */ }
    } catch {
      /* The quarantined ciphertext is the critical forensic artifact. */
    }
  }

  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    this.assertAvailable();
    assertSecretReadLimit(maxBytes);
    const p = this.path(name);
    const encrypted = readSecretFileUtf8Bounded(
      p,
      safeStorageFileLimit(maxBytes),
    );
    if (encrypted === null) return null;
    if (!encrypted.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
      this.quarantineUnreadableSecret(name, p, "invalid-prefix");
      return null;
    }
    let value: string;
    try {
      value = this.safeStorage.decryptString(
        Buffer.from(encrypted.slice(SAFE_STORAGE_SECRET_PREFIX.length), "base64"),
      );
    } catch (err) {
      this.quarantineUnreadableSecret(name, p, "decrypt-failed", err);
      return null;
    }
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
  }

  write(name: string, value: string): void {
    this.assertAvailable();
    const p = this.path(name);
    const encrypted = SAFE_STORAGE_SECRET_PREFIX + this.safeStorage.encryptString(value).toString("base64");
    atomicWriteSecretFile(this.dir, p, encrypted);
  }
}

/**
 * In-memory store — for tests. NOT a production fallback.
 */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  read(
    name: string,
    maxBytes = DEFAULT_SECRET_READ_MAX_BYTES,
  ): string | null {
    assertSecretReadLimit(maxBytes);
    const value = this.map.get(name);
    if (value === undefined) return null;
    assertSecretValueWithinLimit(value, maxBytes);
    return value;
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
  const existing = store.read(AUDIT_HMAC_SECRET_NAME, SECRET_AUTHORITY_MAX_BYTES);
  if (existing && existing.length >= 32) {
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  store.write(AUDIT_HMAC_SECRET_NAME, generated);
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
 * as permission audit entries minus `prevHash`), return the same objects with
 * `prevHash` populated. The first entry's `prevHash` is the
 * genesis-marker HMAC.
 *
 * Used by `audit-logger`'s `appendPermissionAuditEntry` and by tests that need
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
  const stored = store.read(sealKeyName(isoDate), SECRET_AUTHORITY_MAX_BYTES);
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
 * Extract a permission-audit line subset — the audit log file mixes legacy
 * telemetry entries (with `type` field) and permission audit entries (with
 * `decision` field). Chain verification only cares about the permission audit
 * subset; this helper filters them out.
 *
 * Note: in the v1 implementation permission audit entries are written to a
 * dedicated file (`<date>.permission-audit.jsonl`) so this helper is unused
 * in the hot path. Kept exported for forensic tooling that walks
 * mixed telemetry files.
 */
export function filterPermissionAuditLines(lines: string[]): string[] {
  return lines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      return typeof parsed.decision === "string" && typeof parsed.auditId === "string";
    } catch {
      return false;
    }
  });
}
