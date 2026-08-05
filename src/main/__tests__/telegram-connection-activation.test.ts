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
import {
  createUnroutableNotifier,
  startTelegramConnectionActivation,
} from "../telegram-connection-activation.js";
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
  describe("the unroutable notifier", () => {
    it("forwards the notice the ingress chose, not a fixed one", async () => {
      const notify = vi.fn(async () => true);
      const notifier = createUnroutableNotifier({ notify });

      await notifier("998877", "commands-not-supported");

      // The regression: this binding used to be written `async (chatId) => ...`
      // and call `notify(chatId, "conversation-not-shared")`. A callback
      // declared with fewer parameters than it is handed is not a type error,
      // so an owner who was sharing a conversation and sent a slash command
      // was told they had shared nothing.
      expect(notify).toHaveBeenCalledWith("998877", "commands-not-supported");
    });

    it("still carries the other notice", async () => {
      // Non-vacuous: proves the first assertion is about forwarding and not
      // about a second hardcoded value.
      const notify = vi.fn(async () => true);
      await createUnroutableNotifier({ notify })("112233", "conversation-not-shared");
      expect(notify).toHaveBeenCalledWith("112233", "conversation-not-shared");
    });
  });

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
});
