import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TailnetControllerReceiptStore } from "../../api/tailnet-controller-receipt-store.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import {
  createPlatformBridgeInboundGateway,
  type PlatformBridgeInboundAuthorization,
  type PlatformBridgeInboundResult,
  type PlatformBridgeRawWebhookRequest,
  type PlatformBridgeVerifiedEnvelope,
} from "../platform-bridge-inbound.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const ACTOR_DIGEST = "a".repeat(64);
const CONVERSATION_DIGEST = "b".repeat(64);
const PRIVATE_DELIVERY = "private-delivery-001";
const PRIVATE_CHANNEL = "private-channel-001";
const PRIVATE_SENDER = "private-sender-001";
const PRIVATE_TEXT = "private inbound bridge message";
const scratchDirectories: string[] = [];

function envelope(overrides: Partial<PlatformBridgeVerifiedEnvelope> = {}): PlatformBridgeVerifiedEnvelope {
  return {
    provider: "discord",
    deliveryId: PRIVATE_DELIVERY,
    channelId: PRIVATE_CHANNEL,
    senderId: PRIVATE_SENDER,
    text: PRIVATE_TEXT,
    ...overrides,
  };
}

function request(body = new Uint8Array([1, 2, 3])) {
  return {
    rawBody: body,
    headers: { "x-provider-signature": "signature-not-persisted" },
  };
}

function defaultAuthorization(
  isCurrent: () => boolean = () => true,
): PlatformBridgeInboundAuthorization {
  return {
    actorDigest: ACTOR_DIGEST,
    conversationDigest: CONVERSATION_DIGEST,
    bridgeBinding: {
      bridgeId: "00000000-0000-4000-8000-000000000001",
      bridgeEpoch: 1,
      routeId: "00000000-0000-4000-8000-000000000002",
      routeEpoch: 1,
      scope: "00000000-0000-4000-8000-000000000003",
    } as PlatformBridgeInboundAuthorization["bridgeBinding"],
    bridgeGuard: {
      isCurrent,
    } as PlatformBridgeInboundAuthorization["bridgeGuard"],
  };
}

function turnResult() {
  return {
    text: "",
    toolCalls: [],
    route: "test",
  };
}

function createFixture(options: Readonly<{
  enabled?: boolean;
  verify?: (raw: Uint8Array) => unknown | Promise<unknown>;
  authorize?: (value: PlatformBridgeVerifiedEnvelope) => PlatformBridgeInboundAuthorization | null | undefined | Promise<PlatformBridgeInboundAuthorization | null | undefined>;
  submit?: ConversationCommandPort["submit"];
  receiptStore?: TailnetControllerReceiptStore;
  maxRawBodyBytes?: number;
  maxInboundRequestsPerWindow?: number;
  inboundRequestWindowMs?: number;
  maxTrackedInboundAuthorizedPairs?: number;
  receiptOwnerId?: string;
  now?: () => number;
}> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lvis-platform-bridge-inbound-"));
  scratchDirectories.push(directory);
  const filePath = join(directory, "receipts.json");
  const receiptStore = options.receiptStore ?? new TailnetControllerReceiptStore({ filePath });
  const verify = vi.fn((incoming: PlatformBridgeRawWebhookRequest) =>
    options.verify === undefined ? envelope() : options.verify(incoming.rawBody));
  const authorize = vi.fn((value: PlatformBridgeVerifiedEnvelope) =>
    options.authorize === undefined ? defaultAuthorization() : options.authorize(value));
  const submit = options.submit ?? vi.fn(() => ({ completion: Promise.resolve(turnResult()) }));
  const commandPort = { submit } as ConversationCommandPort;
  const gateway = createPlatformBridgeInboundGateway({
    enabled: options.enabled ?? true,
    verifier: { verify },
    authorize,
    receiptStore,
    commandPort,
    ...(options.maxRawBodyBytes === undefined ? {} : { maxRawBodyBytes: options.maxRawBodyBytes }),
    ...(options.maxInboundRequestsPerWindow === undefined
      ? {}
      : { maxInboundRequestsPerWindow: options.maxInboundRequestsPerWindow }),
    ...(options.inboundRequestWindowMs === undefined
      ? {}
      : { inboundRequestWindowMs: options.inboundRequestWindowMs }),
    ...(options.maxTrackedInboundAuthorizedPairs === undefined
      ? {}
      : { maxTrackedInboundAuthorizedPairs: options.maxTrackedInboundAuthorizedPairs }),
    ...(options.receiptOwnerId === undefined ? {} : { receiptOwnerId: options.receiptOwnerId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { gateway, verify, authorize, submit, receiptStore, filePath };
}

afterEach(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    await cleanupTmpDir(directory);
  }
});

describe("PlatformBridgeInboundGateway", () => {
  it("is disabled by default without verifying, authorizing, or admitting provider input", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("disabled");
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("copies provider headers before verification so adapter reuse cannot mutate the verified request", async () => {
    const headers: Record<string, string | readonly string[]> = {
      "x-provider-signature": "original-signature",
      "x-provider-chain": ["first", "second"],
    };
    const fixture = createFixture();

    await expect(fixture.gateway.handleWebhook({ rawBody: new Uint8Array([7]), headers }))
      .resolves.toBe("accepted");
    const verifiedRequest = fixture.verify.mock.calls[0]?.[0];
    expect(verifiedRequest).toBeDefined();
    expect(verifiedRequest?.headers).not.toBe(headers);
    expect(verifiedRequest?.headers).toEqual(headers);

    headers["x-provider-signature"] = "mutated-after-admission";
    expect(verifiedRequest?.headers).toEqual({
      "x-provider-signature": "original-signature",
      "x-provider-chain": ["first", "second"],
    });
  });
  it("verifies raw bytes before strict envelope parsing and sends only a text message through the common port", async () => {
    const body = new Uint8Array([9, 8, 7]);
    const stages: string[] = [];
    const submit = vi.fn(() => {
      stages.push("submit");
      return { completion: Promise.resolve(turnResult()) };
    });
    const fixture = createFixture({
      verify: (raw) => {
        stages.push("verify");
        expect(raw).not.toBe(body);
        expect([...raw]).toEqual([9, 8, 7]);
        raw[0] = 0;
        return envelope();
      },
      authorize: (value) => {
        stages.push("authorize");
        expect(value).toEqual(envelope());
        return defaultAuthorization();
      },
      submit,
    });

    await expect(fixture.gateway.handleWebhook(request(body))).resolves.toBe("accepted");
    expect(stages).toEqual(["verify", "authorize", "submit"]);
    expect([...body]).toEqual([9, 8, 7]);
    expect(fixture.submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.anything(), {
      kind: "message.send",
      payload: { input: PRIVATE_TEXT },
    });
  });

  it("rejects failed verification, non-exact verified payloads, slash commands, and oversized raw bodies before admission", async () => {
    const failed = createFixture({
      verify: () => {
        throw new Error("provider verification failed");
      },
    });
    await expect(failed.gateway.handleWebhook(request())).resolves.toBe("verification-failed");
    expect(failed.authorize).not.toHaveBeenCalled();
    expect(failed.submit).not.toHaveBeenCalled();

    const extraField = createFixture({
      verify: () => ({ ...envelope(), attachmentIds: ["not-allowed"] }),
    });
    await expect(extraField.gateway.handleWebhook(request())).resolves.toBe("invalid-envelope");
    expect(extraField.authorize).not.toHaveBeenCalled();

    const slash = createFixture({ verify: () => envelope({ text: " \n /session new" }) });
    await expect(slash.gateway.handleWebhook(request())).resolves.toBe("slash-command-rejected");
    expect(slash.authorize).not.toHaveBeenCalled();
    expect(slash.submit).not.toHaveBeenCalled();

    const oversized = createFixture({ maxRawBodyBytes: 2 });
    await expect(oversized.gateway.handleWebhook(request(new Uint8Array([1, 2, 3])))).resolves.toBe("request-too-large");
    expect(oversized.verify).not.toHaveBeenCalled();
  });

  it("refuses the control characters a hand-written C0 range walks past", async () => {
    // The inbound class used to be spelled out here as a C0 range plus DEL. It
    // therefore admitted U+009B (CSI, the 8-bit ANSI escape introducer) and
    // U+2028 (LINE SEPARATOR) in provider-supplied text and identifiers, while
    // refusing U+001B and "\n" -- the same categories, written two ways. The
    // shared class covers all of them.
    for (const hostile of ["\u009b", "\u0085", "\u2028", "\u2029"]) {
      const inText = createFixture({ verify: () => envelope({ text: `hello${hostile}world` }) });
      await expect(inText.gateway.handleWebhook(request())).resolves.toBe("invalid-envelope");
      expect(inText.authorize).not.toHaveBeenCalled();

      const inId = createFixture({ verify: () => envelope({ senderId: `sender${hostile}001` }) });
      await expect(inId.gateway.handleWebhook(request())).resolves.toBe("invalid-envelope");
      expect(inId.authorize).not.toHaveBeenCalled();
    }
  });

  it("still admits the tab, newline and carriage return that are message content", async () => {
    const multiline = createFixture({ verify: () => envelope({ text: "line one\nline\ttwo\r" }) });
    await expect(multiline.gateway.handleWebhook(request())).resolves.toBe("accepted");
    expect(multiline.submit).toHaveBeenCalledTimes(1);
  });

  it("rechecks a host-owned pairing guard after durable reservation and releases a revoked delivery", async () => {
    let current = true;
    const directory = mkdtempSync(join(tmpdir(), "lvis-platform-bridge-inbound-revoke-"));
    scratchDirectories.push(directory);
    const backingStore = new TailnetControllerReceiptStore({ filePath: join(directory, "receipts.json") });
    const receiptStore = {
      reserve: (input: Parameters<TailnetControllerReceiptStore["reserve"]>[0]) => {
        const reserved = backingStore.reserve(input);
        current = false;
        return reserved;
      },
      releaseReserved: backingStore.releaseReserved.bind(backingStore),
      settle: backingStore.settle.bind(backingStore),
    };
    const submit = vi.fn(() => ({ completion: Promise.resolve(turnResult()) }));
    const gateway = createPlatformBridgeInboundGateway({
      enabled: true,
      verifier: { verify: () => envelope() },
      authorize: () => defaultAuthorization(() => current),
      receiptStore,
      commandPort: { submit } as unknown as ConversationCommandPort,
    });

    await expect(gateway.handleWebhook(request())).resolves.toBe("authorization-revoked");
    expect(submit).not.toHaveBeenCalled();
    expect(backingStore.reserve({
      keyDigest: "c".repeat(64),
      intentDigest: "d".repeat(64),
      conversationDigest: "e".repeat(64),
      ownerId: "00000000-0000-4000-8000-000000000004",
    })).toEqual({ kind: "reserved" });
  });

  it("durably deduplicates delivery ids without persisting webhook plaintext or admitting changed intent", async () => {
    let candidate = envelope();
    const fixture = createFixture({ verify: () => candidate });

    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("duplicate");
    candidate = envelope({ text: "different private text" });
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("idempotency-conflict");
    expect(fixture.submit).toHaveBeenCalledOnce();

    const persisted = readFileSync(fixture.filePath, "utf8");
    for (const plaintext of [PRIVATE_DELIVERY, PRIVATE_CHANNEL, PRIVATE_SENDER, PRIVATE_TEXT, "different private text"]) {
      expect(persisted).not.toContain(plaintext);
    }
    expect(persisted).toContain("keyDigest");
    expect(persisted).toContain("intentDigest");
    expect(persisted).toContain("conversationDigest");
  });

  it("keeps duplicate deliveries stable before applying a bounded pair rate limit and releases rejected receipts", async () => {
    let now = 0;
    let candidate = envelope();
    const fixture = createFixture({
      verify: () => candidate,
      maxInboundRequestsPerWindow: 1,
      inboundRequestWindowMs: 10,
      maxTrackedInboundAuthorizedPairs: 2,
      now: () => now,
    });

    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("duplicate");

    candidate = envelope({ deliveryId: "private-delivery-002" });
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("rate-limited");
    expect(fixture.submit).toHaveBeenCalledOnce();

    // The over-cap delivery was released rather than made permanently unknown.
    now = 10;
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");
    expect(fixture.submit).toHaveBeenCalledTimes(2);
  });

  it("caps retained anonymized authorized-pair buckets", async () => {
    let authorization = defaultAuthorization();
    let candidate = envelope();
    const fixture = createFixture({
      verify: () => candidate,
      authorize: () => authorization,
      maxInboundRequestsPerWindow: 4,
      maxTrackedInboundAuthorizedPairs: 1,
      now: () => 0,
    });

    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");

    authorization = { ...defaultAuthorization(), actorDigest: "d".repeat(64) };
    candidate = envelope({ deliveryId: "private-delivery-004" });
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("rate-limited");
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("scopes receipt keys to a hashed actor and isolates bounded buckets by authorized pair", async () => {
    let authorization = defaultAuthorization();
    let candidate = envelope();
    const secondActorDigest = "c".repeat(64);
    const fixture = createFixture({
      verify: () => candidate,
      authorize: () => authorization,
      maxInboundRequestsPerWindow: 1,
      maxTrackedInboundAuthorizedPairs: 3,
      now: () => 0,
    });

    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");

    // The exact same provider delivery remains independently idempotent for
    // a different already-hashed host actor; no raw account/channel joins the key.
    authorization = { ...defaultAuthorization(), actorDigest: secondActorDigest };
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");

    candidate = envelope({ deliveryId: "private-delivery-003" });
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("rate-limited");

    // A replacement host pairing for that actor receives its own bucket.
    authorization = {
      ...authorization,
      bridgeBinding: {
        ...authorization.bridgeBinding,
        bridgeId: "00000000-0000-4000-8000-000000000011",
      },
    };
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("accepted");
    expect(fixture.submit).toHaveBeenCalledTimes(3);

    const persisted = readFileSync(fixture.filePath, "utf8");
    for (const value of [ACTOR_DIGEST, secondActorDigest, PRIVATE_CHANNEL, PRIVATE_SENDER]) {
      expect(persisted).not.toContain(value);
    }
  });

  it("rejects invalid inbound rate-limit configuration before constructing a gateway", () => {
    expect(() => createFixture({ maxInboundRequestsPerWindow: 0 })).toThrow(
      "platform-bridge-inbound-max-inbound-requests-per-window-invalid",
    );
    expect(() => createFixture({ inboundRequestWindowMs: Number.POSITIVE_INFINITY })).toThrow(
      "platform-bridge-inbound-inbound-request-window-ms-invalid",
    );
    expect(() => createFixture({ maxTrackedInboundAuthorizedPairs: 1.5 })).toThrow(
      "platform-bridge-inbound-max-tracked-inbound-authorized-pairs-invalid",
    );
    expect(() => createFixture({ now: "not-a-clock" as never })).toThrow(
      "platform-bridge-inbound-now-invalid",
    );
  });

  it("accepts only a well-formed host-minted receipt owner id", () => {
    for (const receiptOwnerId of ["", "not-a-uuid", "1e7d0f3a-0000-4000-8000-00000000a00", 42 as never]) {
      expect(() => createFixture({ receiptOwnerId })).toThrow(
        "platform-bridge-inbound-receipt-owner-invalid",
      );
    }
    expect(() => createFixture({ receiptOwnerId: "1e7d0f3a-0000-4000-8000-00000000a001" })).not.toThrow();
    expect(() => createFixture({})).not.toThrow();
  });

  it("normalizes an admission throw as replay-unsafe and never exposes failure detail", async () => {
    const fixture = createFixture({
      submit: vi.fn(() => {
        throw new Error("private adapter failure");
      }),
    });

    const result: PlatformBridgeInboundResult = await fixture.gateway.handleWebhook(request());
    expect(result).toBe("command-outcome-unknown");
    expect(fixture.submit).toHaveBeenCalledOnce();
    await expect(fixture.gateway.handleWebhook(request())).resolves.toBe("command-outcome-unknown");
  });
});
