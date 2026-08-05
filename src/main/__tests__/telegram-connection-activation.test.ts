/**
 * The activation is the only place that knows a fatal poll outcome and an
 * owner-initiated disconnect have to converge. Ingress stopping on its own
 * leaves egress attached, so this suite drives the real activation against a
 * rejecting provider and asserts the teardown it is supposed to trigger.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import {
  resetTelegramBridgeServerForTests,
  stopTelegramBridgeServer,
} from "../telegram-bridge-server.js";
import { startTelegramConnectionActivation } from "../telegram-connection-activation.js";
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from "../telegram-connection-service.js";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import { telegramConversationDigest } from "../telegram-platform-runtime.js";
import { namespaceAt } from "./telegram-connection-namespace.js";

const BOT_TOKEN = "8112233445:activation-suite-bot-token";
/** The store only ever holds digests, so the fingerprint is what it is given. */
const BOT_FINGERPRINT = "f".repeat(64);

let directories: string[] = [];

afterEach(() => {
  resetTelegramBridgeServerForTests();
  vi.unstubAllGlobals();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lvis-telegram-activation-"));
  directories.push(directory);
  return directory;
}

async function connectedStore(): Promise<TelegramConnectionStore> {
  const store = createTelegramConnectionStore({
    namespace: namespaceAt(tempDirectory()),
    now: () => 1_700_000_000_000,
    conversationDigestFor: telegramConversationDigest,
  });
  await store.open();
  await store.setConnected(BOT_FINGERPRINT);
  return store;
}

/** An in-memory stand-in for the OS-encrypted store the actor key lives in. */
function memorySecretStore() {
  const values = new Map<string, string>();
  return {
    read: (name: string) => values.get(name) ?? null,
    write: (name: string, value: string) => {
      values.set(name, value);
    },
  };
}

/**
 * Every Bot API call answers 401. `getUpdates` maps that to `unauthorized`,
 * which is the one provider outcome the poller treats as unrecoverable.
 */
function stubRejectingProvider(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  )));
}

/**
 * Every Bot API call succeeds and the bot has no backlog, which is what the
 * poller sees on an ordinary healthy connection.
 *
 * Polls after the seeding one park until the ingress aborts. An instantly
 * answered long poll would otherwise spin the loop on resolved promises and
 * starve the timers `vi.waitFor` runs on.
 */
function stubEmptyProvider(): void {
  let polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/getUpdates") && ++polls > 1) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    }
    return new Response(
      JSON.stringify({ ok: true, result: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }));
}

/**
 * The real store with named writes broken.
 *
 * The methods are closures rather than prototype members, so a spread keeps
 * every untouched one wired to the same document the assertions read back. That
 * is the point: this is a store that persists everything except what the test
 * breaks, which is what a revoked ACL on the feature directory or a locked file
 * actually produces.
 */
function storeWithFailingWrites(
  store: TelegramConnectionStore,
  ...names: readonly ("recordPollOffset" | "setLastError")[]
): TelegramConnectionStore {
  const broken = Object.fromEntries(names.map((name) => [
    name,
    async () => {
      throw new Error("telegram-connection-store-write-failed");
    },
  ]));
  return { ...store, ...broken };
}

function activationInput(store: TelegramConnectionStore, stopBridge: () => Promise<void>) {
  return {
    store,
    settingsService: { getEncryptedSecret: (key: string) => (
      key === TELEGRAM_BOT_TOKEN_SECRET_KEY ? BOT_TOKEN : null
    ) },
    conversationSurfaceRuntime: {
      sharedProjection: {},
      activity: { isBusy: () => false },
    } as unknown as ConversationSurfaceRuntime,
    conversationCommandPort: { submit: vi.fn() } as unknown as ConversationCommandPort,
    getCurrentConversationId: () => "active-conversation",
    stopBridge,
    secretStore: memorySecretStore(),
  };
}

describe("telegram connection activation", () => {
  it("tears the activation down when the provider rejects the token", async () => {
    stubRejectingProvider();
    const store = await connectedStore();
    // The real teardown, exactly as `main.ts` wires it. A stub would pass even
    // if the handler and the teardown were waiting on each other, which is the
    // failure this whole path is about.
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(store, stopBridge));
    await vi.waitFor(() => {
      expect(store.ownerSnapshot().lastErrorCode).toBe("telegram-bot-token-rejected");
    });

    // The error alone is not the invariant: a bridge that records a fatal code
    // and keeps its egress channel open still streams assistant text to a phone
    // whose messages can no longer arrive.
    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    // Settling it here rather than leaving it in flight is the deadlock check:
    // the teardown cannot finish until the poll loop that started it unwinds.
    await stopBridge.mock.results[0]?.value;
    // Throws while anything is still active, so reaching this line is the proof
    // that the teardown ran to completion rather than merely being started.
    resetTelegramBridgeServerForTests();
  });

  it("tears the activation down when the poll offset cannot be persisted", async () => {
    stubEmptyProvider();
    const real = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(
      storeWithFailingWrites(real, "recordPollOffset"),
      stopBridge,
    ));

    // The write is the only injected callback whose failure used to escape the
    // loop unclassified: ingress died, nothing was recorded, and the owner
    // surface went on reading `connected` with egress still attached.
    await vi.waitFor(() => {
      expect(real.ownerSnapshot().lastErrorCode).toBe("telegram-connection-state-unwritable");
    });
    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    await stopBridge.mock.results[0]?.value;
    resetTelegramBridgeServerForTests();
  });

  it("tears the activation down even when the fatal outcome cannot be recorded", async () => {
    stubEmptyProvider();
    const real = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    // The realistic shape of this failure: a store that cannot take the offset
    // cannot take the error about it either. Recording it first and awaiting
    // that write meant the throw skipped the teardown, so the one fatal outcome
    // that says "nothing this connection learns can be saved" was also the one
    // that left egress streaming to the phone.
    await startTelegramConnectionActivation(activationInput(
      storeWithFailingWrites(real, "recordPollOffset", "setLastError"),
      stopBridge,
    ));

    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    await stopBridge.mock.results[0]?.value;
    // Nothing could be written, which is why the teardown is the only honest
    // signal left rather than a redundant one.
    expect(real.ownerSnapshot().lastErrorCode).toBeNull();
    resetTelegramBridgeServerForTests();
  });

  it("keeps receiving when the same poll writes the offset through", async () => {
    stubEmptyProvider();
    const store = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(store, stopBridge));

    // The control for both cases above: identical wiring, identical provider,
    // and the only difference is a store that accepts the write.
    await vi.waitFor(() => {
      expect(store.pollOffset()).toBe(0);
    });
    expect(store.ownerSnapshot().lastErrorCode).toBeNull();
    expect(stopBridge).not.toHaveBeenCalled();

    await stopTelegramBridgeServer("user");
    resetTelegramBridgeServerForTests();
  });
});
