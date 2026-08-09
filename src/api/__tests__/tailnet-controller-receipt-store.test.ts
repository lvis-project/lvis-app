import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TailnetControllerReceiptStore,
  type TailnetControllerReceiptReservation,
} from "../tailnet-controller-receipt-store.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const OWNER_ONE = "00000000-0000-4000-8000-000000000001";
const OWNER_TWO = "00000000-0000-4000-8000-000000000002";
const scratchDirs: string[] = [];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(options: Readonly<{ now?: () => number; ttlMs?: number; maxReceipts?: number }> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-controller-receipts-"));
  scratchDirs.push(directory);
  const filePath = join(directory, "command-receipts.json");
  return {
    filePath,
    store: new TailnetControllerReceiptStore({ filePath, ...options }),
  };
}

function reservation(overrides: Partial<TailnetControllerReceiptReservation> = {}): TailnetControllerReceiptReservation {
  return {
    keyDigest: digest("actor-digest\u0000command-id"),
    intentDigest: digest("canonical command intent"),
    conversationDigest: digest("private conversation id"),
    ownerId: OWNER_ONE,
    ...overrides,
  };
}

afterEach(async () => {
  for (const directory of scratchDirs.splice(0)) await cleanupTmpDir(directory);
});

describe("Tailnet controller receipt store", () => {
  it("preserves terminal receipts across restart and rejects changed intent or conversation", () => {
    const fixture = createFixture();
    const first = reservation();
    expect(fixture.store.reserve(first)).toEqual({ kind: "reserved" });
    fixture.store.settle(first);

    const restarted = new TailnetControllerReceiptStore({ filePath: fixture.filePath });
    expect(restarted.reserve({ ...first, ownerId: OWNER_TWO })).toEqual({ kind: "duplicate" });
    expect(restarted.reserve({ ...first, ownerId: OWNER_TWO, intentDigest: digest("changed command intent") })).toEqual({ kind: "conflict" });
    expect(restarted.reserve({ ...first, ownerId: OWNER_TWO, conversationDigest: digest("other private conversation") })).toEqual({ kind: "conflict" });
  });

  it("turns a crash-left reservation into outcome-unknown for a new owner without replaying", () => {
    const fixture = createFixture();
    const first = reservation();
    expect(fixture.store.reserve(first)).toEqual({ kind: "reserved" });
    expect(fixture.store.reserve(first)).toEqual({ kind: "duplicate" });

    const restarted = new TailnetControllerReceiptStore({ filePath: fixture.filePath });
    expect(restarted.reserve({ ...first, ownerId: OWNER_TWO })).toEqual({ kind: "outcome-unknown" });
  });

  it("does not expire a long-running reservation, including after restart", () => {
    let now = 1_700_000_000_000;
    const fixture = createFixture({ now: () => now, ttlMs: 1_000 });
    const first = reservation();
    expect(fixture.store.reserve(first)).toEqual({ kind: "reserved" });

    now += 1_001;
    const restarted = new TailnetControllerReceiptStore({
      filePath: fixture.filePath,
      now: () => now,
      ttlMs: 1_000,
    });
    expect(restarted.reserve({ ...first, ownerId: OWNER_TWO })).toEqual({ kind: "outcome-unknown" });
  });

  it("starts the terminal replay window at settlement after a long-running reservation", () => {
    let now = 1_700_000_000_000;
    const fixture = createFixture({ now: () => now, ttlMs: 1_000 });
    const first = reservation();
    expect(fixture.store.reserve(first)).toEqual({ kind: "reserved" });

    now += 1_001;
    fixture.store.settle(first);
    expect(fixture.store.reserve({ ...first, ownerId: OWNER_TWO })).toEqual({ kind: "duplicate" });

    now += 1_001;
    expect(fixture.store.reserve({ ...first, ownerId: OWNER_TWO })).toEqual({ kind: "reserved" });
  });

  it("fails closed at capacity instead of evicting a live receipt", () => {
    const fixture = createFixture({ maxReceipts: 1 });
    const first = reservation();
    const second = reservation({ keyDigest: digest("actor-digest\u0000other-command") });
    expect(fixture.store.reserve(first)).toEqual({ kind: "reserved" });
    expect(fixture.store.reserve(second)).toEqual({ kind: "capacity-exhausted" });
    fixture.store.releaseReserved(first);
    expect(fixture.store.reserve(second)).toEqual({ kind: "reserved" });
  });

  it("fails closed when the durable file is malformed or violates the strict schema", () => {
    const fixture = createFixture();
    writeFileSync(fixture.filePath, "not json", "utf8");
    expect(() => fixture.store.reserve(reservation())).toThrow("tailnet-controller-receipt-store-invalid");

    writeFileSync(fixture.filePath, JSON.stringify({ version: 1, receipts: [], ignored: true }), "utf8");
    expect(() => fixture.store.reserve(reservation())).toThrow("tailnet-controller-receipt-store-invalid");
  });

  it("persists only supplied digests and generated owner state, never controller plaintext", () => {
    const fixture = createFixture();
    const rawLogin = "alice@example.test";
    const rawCommandId = "controller-command-secret";
    const rawInput = "send the private deployment plan";
    const rawConversation = "conversation-plaintext-secret";
    const input = reservation({
      keyDigest: digest(`${rawLogin}\u0000${rawCommandId}`),
      intentDigest: digest(rawInput),
      conversationDigest: digest(rawConversation),
    });

    expect(fixture.store.reserve(input)).toEqual({ kind: "reserved" });
    const disk = readFileSync(fixture.filePath, "utf8");
    for (const value of [rawLogin, rawCommandId, rawInput, rawConversation]) expect(disk).not.toContain(value);
    expect(JSON.parse(disk)).toMatchObject({ version: 1, receipts: [{ keyDigest: input.keyDigest, intentDigest: input.intentDigest, conversationDigest: input.conversationDigest }] });
  });
});
