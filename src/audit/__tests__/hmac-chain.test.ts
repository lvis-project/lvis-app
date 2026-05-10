/**
 * HMAC chain integrity tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7.
 *
 * Coverage:
 *   1. Round-trip: build chain → verify → ok.
 *   2. Tamper detection: mutate one line → verifyChain reports first
 *      broken index.
 *   3. Daily seal write/verify lifecycle.
 *   4. Secret persistence — ensureAuditSecret idempotence.
 *   5. File-secret-store mode bits.
 *   6. Genesis marker handling.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChainedEntries,
  computeDailySeal,
  computeLineHmac,
  ensureAuditSecret,
  FileSecretStore,
  filterPermissionAuditLines,
  GENESIS_MARKER,
  MemorySecretStore,
  SafeStorageSecretStore,
  type SafeStorageLike,
  sealDayFromFile,
  sealKeyName,
  verifyChain,
  verifyDailySeal,
  verifyLineHmac,
} from "../hmac-chain.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lvis-hmac-chain-"));
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("ensureAuditSecret", () => {
  it("generates a fresh hex secret on first call", () => {
    const store = new MemorySecretStore();
    const secret = ensureAuditSecret(store);
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
  });

  it("returns the same secret on subsequent calls (idempotent)", () => {
    const store = new MemorySecretStore();
    const a = ensureAuditSecret(store);
    const b = ensureAuditSecret(store);
    expect(a).toBe(b);
  });

  it("regenerates when stored secret is too short", () => {
    const store = new MemorySecretStore();
    store.write("audit-hmac.key", "short");
    const secret = ensureAuditSecret(store);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});

describe("FileSecretStore", () => {
  it("writes secrets with 0o600 mode", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    store.write("audit-hmac.key", "deadbeef");
    const filePath = join(workDir, "secrets", "audit-hmac.key");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reads back what was written", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    store.write("audit-hmac.key", "hello-secret");
    expect(store.read("audit-hmac.key")).toBe("hello-secret");
  });

  it("rejects path-traversal in secret name", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    expect(() => store.write("../escape", "x")).toThrow(/invalid secret name/);
  });

  it("read returns null for absent secret", () => {
    const store = new FileSecretStore(join(workDir, "secrets"));
    expect(store.read("missing")).toBe(null);
  });
});

describe("SafeStorageSecretStore", () => {
  function makeSafeStorage(): SafeStorageLike {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf-8"),
      decryptString: (value: Buffer) => value.toString("utf-8").replace(/^enc:/, ""),
    };
  }

  it("persists encrypted ciphertext with 0o600 mode", () => {
    const store = new SafeStorageSecretStore(makeSafeStorage(), join(workDir, "secrets"));
    store.write("audit-hmac.key", "hello-secret");
    const filePath = join(workDir, "secrets", "audit-hmac.key.safe-storage");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.read("audit-hmac.key")).toBe("hello-secret");
  });

  it("throws when safeStorage becomes unavailable", () => {
    const store = new SafeStorageSecretStore({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(""),
      decryptString: () => "",
    }, join(workDir, "secrets"));
    expect(() => store.write("audit-hmac.key", "x")).toThrow(/safeStorage/);
  });
});

describe("computeLineHmac + verifyLineHmac", () => {
  it("verifies a valid hash", () => {
    const secret = "00".repeat(32);
    const line = '{"decision":"allow"}';
    const hash = computeLineHmac(secret, line);
    expect(verifyLineHmac(secret, line, hash)).toBe(true);
  });

  it("rejects tampered hash", () => {
    const secret = "00".repeat(32);
    const line = '{"decision":"allow"}';
    const hash = computeLineHmac(secret, line);
    // Mutate one hex char
    const tampered = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    expect(verifyLineHmac(secret, line, tampered)).toBe(false);
  });

  it("rejects mismatched length without throwing", () => {
    const secret = "00".repeat(32);
    expect(verifyLineHmac(secret, "x", "deadbeef")).toBe(false);
  });
});

describe("buildChainedEntries", () => {
  it("first entry hashes against the genesis marker", () => {
    const secret = "aa".repeat(32);
    const out = buildChainedEntries(secret, [{ decision: "allow", n: 1 }]);
    expect(out[0].prevHash).toBe(computeLineHmac(secret, GENESIS_MARKER));
  });

  it("each subsequent entry hashes against the previous serialized line", () => {
    const secret = "aa".repeat(32);
    const out = buildChainedEntries(secret, [
      { decision: "allow", n: 1 },
      { decision: "deny", n: 2 },
      { decision: "ask", n: 3 },
    ]);
    const line0 = JSON.stringify(out[0]);
    const line1 = JSON.stringify(out[1]);
    expect(out[1].prevHash).toBe(computeLineHmac(secret, line0));
    expect(out[2].prevHash).toBe(computeLineHmac(secret, line1));
  });
});

describe("verifyChain", () => {
  /**
   * Build a 12-entry fixture so the tampered-mid-line test has plenty
   * of context. ≥10 entries with one mid-line tampered (per Phase 5 hard
   * rules).
   */
  function buildFixture(secret: string, n = 12): { entries: Array<Record<string, unknown>>; lines: string[] } {
    const raw = Array.from({ length: n }, (_, i) => ({
      decision: i % 2 === 0 ? "allow" : "deny",
      auditId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      ts: `2026-05-09T00:00:${String(i).padStart(2, "0")}.000Z`,
      tool: `tool-${i}`,
    }));
    const entries = buildChainedEntries(secret, raw);
    const lines = entries.map((e) => JSON.stringify(e));
    return { entries, lines };
  }

  it("accepts a 12-entry round-trip chain", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    expect(verifyChain(secret, lines)).toEqual({ ok: true });
  });

  it("detects a tampered MIDDLE line and reports its index+1 (next link breaks)", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    // Tamper line 5 — flip a string field
    const obj = JSON.parse(lines[5]) as { tool: string };
    obj.tool = "TAMPERED";
    lines[5] = JSON.stringify(obj);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Mutating line N keeps line N's own prevHash valid (the link
      // chains forward from line N-1) but breaks line N+1 whose
      // prevHash was computed against line N's *original* serialization.
      expect(result.firstBrokenLineIndex).toBe(6);
      expect(result.reason).toBe("hmac-mismatch");
    }
  });

  it("detects when the FIRST line is tampered (its own prevHash will mismatch)", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 12);
    const obj = JSON.parse(lines[0]) as { prevHash: string };
    // Replace prevHash with a wrong one
    obj.prevHash = computeLineHmac(secret, "wrong-genesis");
    lines[0] = JSON.stringify(obj);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBrokenLineIndex).toBe(0);
    }
  });

  it("detects unparseable lines", () => {
    const secret = "bb".repeat(32);
    const { lines } = buildFixture(secret, 5);
    lines[2] = "<<not-json>>";
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBrokenLineIndex).toBe(2);
      expect(result.reason).toBe("json-parse-error");
    }
  });

  it("detects missing prevHash field", () => {
    const secret = "bb".repeat(32);
    const out = buildChainedEntries(secret, [
      { decision: "allow", n: 1 },
      { decision: "deny", n: 2 },
    ]);
    const lines = out.map((e) => JSON.stringify(e));
    const corrupted = JSON.parse(lines[1]) as Record<string, unknown>;
    delete corrupted.prevHash;
    lines[1] = JSON.stringify(corrupted);
    const result = verifyChain(secret, lines);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-prevHash");
    }
  });

  it("accepts an empty input as trivially valid", () => {
    const secret = "cc".repeat(32);
    expect(verifyChain(secret, [])).toEqual({ ok: true });
  });
});

describe("daily seal lifecycle", () => {
  it("sealDayFromFile writes the seal to the store and returns it", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);

    const entries = buildChainedEntries(secret, [
      { decision: "allow", n: 1 },
      { decision: "deny", n: 2 },
    ]);
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const seal = sealDayFromFile(secret, store, filePath, date);
    expect(seal).not.toBe(null);
    expect(store.read(sealKeyName(date))).toBe(seal);
  });

  it("sealDayFromFile returns null on empty file", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "empty.permission-audit.jsonl");
    writeFileSync(filePath, "");
    expect(sealDayFromFile(secret, store, filePath, "2026-05-09")).toBe(null);
  });

  it("sealDayFromFile returns null when the file does not exist", () => {
    const secret = "dd".repeat(32);
    const store = new MemorySecretStore();
    expect(sealDayFromFile(secret, store, join(workDir, "nope"), "2026-05-09")).toBe(null);
  });

  it("verifyDailySeal — ok on intact chain + matching seal", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);
    const entries = buildChainedEntries(secret, [
      { decision: "allow", n: 1 },
      { decision: "deny", n: 2 },
      { decision: "ask", n: 3 },
    ]);
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    sealDayFromFile(secret, store, filePath, date);
    expect(verifyDailySeal(secret, store, filePath, date)).toEqual({ ok: true });
  });

  it("verifyDailySeal — chain-broken when a line is tampered", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const date = "2026-05-09";
    const filePath = join(workDir, `${date}.permission-audit.jsonl`);
    const entries = buildChainedEntries(secret, [
      { decision: "allow", n: 1 },
      { decision: "deny", n: 2 },
      { decision: "ask", n: 3 },
      { decision: "allow", n: 4 },
    ]);
    const lines = entries.map((e) => JSON.stringify(e));
    writeFileSync(filePath, lines.join("\n") + "\n");
    sealDayFromFile(secret, store, filePath, date);

    // Tamper line 1
    const obj = JSON.parse(lines[1]) as { decision: string };
    obj.decision = "allow";
    lines[1] = JSON.stringify(obj);
    writeFileSync(filePath, lines.join("\n") + "\n");

    const result = verifyDailySeal(secret, store, filePath, date);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "chain-broken") {
      expect(result.firstBrokenLineIndex).toBe(2);
    } else {
      throw new Error(`expected chain-broken, got ${JSON.stringify(result)}`);
    }
  });

  it("verifyDailySeal — no-seal when seal was never written", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "2026-05-09.permission-audit.jsonl");
    writeFileSync(filePath, JSON.stringify({ decision: "allow", prevHash: "x" }) + "\n");
    const result = verifyDailySeal(secret, store, filePath, "2026-05-09");
    expect(result).toEqual({ ok: false, reason: "no-seal" });
  });

  it("verifyDailySeal — no-file when the file is missing", () => {
    const secret = "ee".repeat(32);
    const store = new MemorySecretStore();
    const result = verifyDailySeal(secret, store, join(workDir, "nope"), "2026-05-09");
    expect(result).toEqual({ ok: false, reason: "no-file" });
  });

  it("sealKeyName format", () => {
    expect(sealKeyName("2026-05-09")).toBe("audit-seal-2026-05-09");
    expect(() => sealKeyName("2026/05/09")).toThrow();
  });

  it("computeDailySeal is deterministic for same secret+line", () => {
    const a = computeDailySeal("aa".repeat(32), "abc");
    const b = computeDailySeal("aa".repeat(32), "abc");
    expect(a).toBe(b);
    expect(a).not.toBe(computeDailySeal("bb".repeat(32), "abc"));
  });

  it("seal verification works end-to-end with a fresh secret rotation", () => {
    // Simulating "rotate the keychain secret" — the old seal becomes
    // unverifiable, which is the *desired* property: a stolen file
    // cannot be re-sealed without the new secret.
    const oldSecret = "11".repeat(32);
    const newSecret = "22".repeat(32);
    const store = new MemorySecretStore();
    const filePath = join(workDir, "2026-05-09.permission-audit.jsonl");
    const entries = buildChainedEntries(oldSecret, [{ decision: "allow", n: 1 }]);
    writeFileSync(filePath, JSON.stringify(entries[0]) + "\n");
    sealDayFromFile(oldSecret, store, filePath, "2026-05-09");
    // Rotation — store the new secret. The old seal stays in store
    // but verification under the new secret fails.
    const result = verifyDailySeal(newSecret, store, filePath, "2026-05-09");
    expect(result.ok).toBe(false);
  });
});

describe("filterPermissionAuditLines", () => {
  it("filters mixed legacy + permission audit lines", () => {
    const legacy = JSON.stringify({ type: "turn", sessionId: "s1" });
    const permissionAudit = JSON.stringify({ decision: "allow", auditId: "id-1" });
    const broken = "<<not-json>>";
    expect(filterPermissionAuditLines([legacy, permissionAudit, broken])).toEqual([permissionAudit]);
  });
});
