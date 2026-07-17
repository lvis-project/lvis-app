import { describe, expect, it } from "vitest";
import { createCipheriv, createHash } from "node:crypto";
import { A2AExactReplayStore } from "../a2a-exact-replay-store.js";

function fixture() {
  let persisted: unknown;
  const namespace = {
    readJson: async <T>(_name: string, fallback: T): Promise<T> => structuredClone((persisted ?? fallback) as T),
    writeJson: async (_name: string, value: unknown): Promise<void> => { persisted = structuredClone(value); },
  };
  const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value, "utf8"), decryptString: (value: Buffer) => value.toString("utf8") };
  return { namespace, encryption, persisted: () => persisted };
}

describe("A2A exact replay receiver store", () => {
  it("uses keyed tokens, encrypts the completed wrapper, and returns it without re-execution", async () => {
    const f = fixture();
    const store = new A2AExactReplayStore({ namespace: f.namespace, encryption: f.encryption, maxKeysPerGeneration: 2, makeOwnerToken: () => "live-owner-secret", random: (size) => Buffer.alloc(size, 7) });
    const input = { callerGenerationId: "caller-secret", messageId: "message-secret", bodySha256: "a".repeat(64), intentSha256: "b".repeat(64) };
    const begun = await store.begin(input);
    expect(begun).toEqual({ kind: "owner", ownerToken: "live-owner-secret" });
    await expect(store.complete("live-owner-secret", { message: { messageId: "reply-secret", role: "ROLE_AGENT", parts: [{ text: "result-secret" }] } })).resolves.toBe(true);
    await expect(store.begin(input)).resolves.toMatchObject({ kind: "completed", result: { message: { messageId: "reply-secret" } } });
    const disk = JSON.stringify(f.persisted());
    for (const secret of ["live-owner-secret", "caller-secret", "message-secret", "reply-secret", "result-secret"]) expect(disk).not.toContain(secret);
  });

  it("converts a crash-left owner to outcome-unknown before accepting any replay", async () => {
    const f = fixture();
    const input = {
      callerGenerationId: "caller-generation",
      messageId: "message-id",
      bodySha256: "a".repeat(64),
      intentSha256: "b".repeat(64),
    };
    const firstBoot = new A2AExactReplayStore({
      namespace: f.namespace,
      encryption: f.encryption,
      maxKeysPerGeneration: 2,
      makeOwnerToken: () => "owner-before-crash",
      random: (size) => Buffer.alloc(size, 5),
    });
    await expect(firstBoot.begin(input)).resolves.toEqual({
      kind: "owner",
      ownerToken: "owner-before-crash",
    });

    const restarted = new A2AExactReplayStore({
      namespace: f.namespace,
      encryption: f.encryption,
      maxKeysPerGeneration: 2,
      random: (size) => Buffer.alloc(size, 9),
    });
    await expect(restarted.begin(input)).resolves.toEqual({ kind: "outcome-unknown" });
    expect(JSON.stringify(f.persisted())).not.toContain("owner-before-crash");
  });

  it("expires completed ciphertext to a durable tombstone and rejects late owners", async () => {
    const f = fixture();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new A2AExactReplayStore({
      namespace: f.namespace,
      encryption: f.encryption,
      maxKeysPerGeneration: 3,
      now: () => now,
      retentionMs: 1_000,
      makeOwnerToken: () => "owner-token",
      random: (size) => Buffer.alloc(size, 4),
    });
    const completedInput = {
      callerGenerationId: "caller-generation",
      messageId: "completed-message",
      bodySha256: "a".repeat(64),
      intentSha256: "b".repeat(64),
    };
    await store.begin(completedInput);
    await store.complete("owner-token", {
      message: {
        messageId: "secret-result-id",
        role: "ROLE_AGENT",
        parts: [{ text: "secret-result-body" }],
      },
    });
    expect(JSON.stringify(f.persisted())).toContain("resultCiphertext");

    now = new Date("2026-01-01T00:00:01.001Z");
    await expect(store.expireDue()).resolves.toBe(1);
    const disk = JSON.stringify(f.persisted());
    expect(disk).toContain("RETENTION_EXPIRED");
    for (const field of [
      "resultCiphertext",
      "resultIv",
      "resultAuthTag",
      "resultCiphertextSha256",
      "secret-result-id",
      "secret-result-body",
    ]) {
      expect(disk).not.toContain(field);
    }
    await expect(store.begin(completedInput)).resolves.toEqual({
      kind: "retention-expired",
    });

    now = new Date("2026-01-01T00:00:02.000Z");
    const lateInput = {
      ...completedInput,
      messageId: "late-message",
      bodySha256: "c".repeat(64),
    };
    const late = await store.begin(lateInput);
    expect(late).toMatchObject({ kind: "owner" });
    now = new Date("2026-01-01T00:00:03.001Z");
    await expect(store.complete("owner-token", {
      message: { messageId: "too-late", role: "ROLE_AGENT", parts: [] },
    })).resolves.toBe(false);
    await expect(store.markOutcomeUnknown("owner-token")).resolves.toBe(false);
  });

  it("rejects duplicate, over-capacity, timestamp, crypto, and decrypted-result corruption on restart", async () => {
    const f = fixture();
    const store = new A2AExactReplayStore({
      namespace: f.namespace,
      encryption: f.encryption,
      maxKeysPerGeneration: 2,
      makeOwnerToken: () => "owner-token",
      random: (size) => Buffer.alloc(size, 7),
    });
    const input = {
      callerGenerationId: "caller-generation",
      messageId: "message-id",
      bodySha256: "a".repeat(64),
      intentSha256: "b".repeat(64),
    };
    await store.begin(input);
    await store.complete("owner-token", {
      message: { messageId: "reply-id", role: "ROLE_AGENT", parts: [{ text: "reply" }] },
    });
    const valid = structuredClone(f.persisted()) as any;

    const invalidResult = (state: any) => {
      const record = state.records[0];
      const encryptedKey = Buffer.from(state.encryptedDataKey, "base64");
      const key = Buffer.from(f.encryption.decryptString(encryptedKey), "base64");
      const iv = Buffer.alloc(12, 9);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`result\0${record.keyToken}\0${record.bodySha256}\0${record.intentSha256}`));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ message: { invalid: true } }), "utf8"),
        cipher.final(),
      ]);
      record.resultCiphertext = ciphertext.toString("base64");
      record.resultIv = iv.toString("base64");
      record.resultAuthTag = cipher.getAuthTag().toString("base64");
      record.resultCiphertextSha256 = createHash("sha256").update(ciphertext).digest("hex");
      key.fill(0);
      encryptedKey.fill(0);
    };

    const mutations: Array<[string, (state: any) => void, number?]> = [
      ["encrypted key encoding", (state) => { state.encryptedDataKey = "***"; }],
      ["duplicate key", (state) => { state.records.push(structuredClone(state.records[0])); }],
      ["duplicate caller/message", (state) => {
        const duplicate = { ...structuredClone(state.records[0]), keyToken: "f".repeat(64), state: "RETENTION_EXPIRED" };
        delete duplicate.resultCiphertext;
        delete duplicate.resultIv;
        delete duplicate.resultAuthTag;
        delete duplicate.resultCiphertextSha256;
        state.records.push(duplicate);
      }],
      ["caller capacity", (state) => {
        const extra = { ...structuredClone(state.records[0]), keyToken: "e".repeat(64), messageToken: "d".repeat(64), state: "RETENTION_EXPIRED" };
        delete extra.resultCiphertext;
        delete extra.resultIv;
        delete extra.resultAuthTag;
        delete extra.resultCiphertextSha256;
        state.records.push(extra);
      }, 1],
      ["retention interval", (state) => { state.records[0].expiresAt = state.records[0].firstAcceptedAt; }],
      ["ciphertext base64", (state) => { state.records[0].resultCiphertext = "***"; }],
      ["iv length", (state) => { state.records[0].resultIv = Buffer.alloc(11).toString("base64"); }],
      ["tag length", (state) => { state.records[0].resultAuthTag = Buffer.alloc(15).toString("base64"); }],
      ["ciphertext digest", (state) => { state.records[0].resultCiphertextSha256 = "0".repeat(64); }],
      ["AEAD binding", (state) => {
        const bytes = Buffer.from(state.records[0].resultCiphertext, "base64");
        bytes[0] = bytes[0]! ^ 1;
        state.records[0].resultCiphertext = bytes.toString("base64");
        state.records[0].resultCiphertextSha256 = createHash("sha256").update(bytes).digest("hex");
      }],
      ["decrypted result", invalidResult],
    ];

    for (const [label, mutate, maxKeysPerGeneration = 2] of mutations) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      const restarted = new A2AExactReplayStore({
        namespace: {
          readJson: async () => structuredClone(candidate),
          writeJson: async () => undefined,
        },
        encryption: f.encryption,
        maxKeysPerGeneration,
      });
      await expect(restarted.expireDue(), label).rejects.toThrow();
    }
  });
});
