/**
 * LvisClient facade — #1409 C12 SDK wrapping proof.
 *
 * Asserts the narrow facade (1) routes each read method to the correct public
 * channel, (2) propagates its bound origin ('local-api' | 'cli') on every
 * dispatch, and (3) throws a typed {@link LvisClientError} when the dispatcher
 * fails closed. An integration slice wraps a REAL local-api to prove the same
 * contract flows renderer→handler through the 'cli' origin.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createLvisClient,
  LvisClientError,
} from "../index.js";
import type { LocalApi, LocalApiRequest, LocalApiResult } from "../../api/local-api.js";
import { createLocalApi, type LocalApiDeps } from "../../api/local-api.js";
import type { ChatSendContext } from "../../ipc/handlers/chat.js";
import type { IpcDeps } from "../../ipc/types.js";
import { CHANNELS, PERMISSIONS } from "../../contract/app-contract.js";

function fakeApi(impl: (req: LocalApiRequest) => LocalApiResult): {
  api: LocalApi;
  calls: LocalApiRequest[];
} {
  const calls: LocalApiRequest[] = [];
  const api: LocalApi = {
    dispatch: vi.fn(async (req: LocalApiRequest) => {
      calls.push(req);
      return impl(req);
    }),
  };
  return { api, calls };
}

describe("LvisClient — read routing + origin propagation", () => {
  it("routes each read method to its public channel with the bound origin", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, data: null }));
    const client = createLvisClient(api, "local-api");

    await client.listSessions({ limit: 5 });
    await client.getHistory();
    await client.getHistory("session-42");
    await client.listPlugins();
    await client.listMarketplace();
    await client.getPermissionMode();
    await client.getUsageSummary(30);
    await client.getUsageRange({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    expect(calls.map((c) => c.channel)).toEqual([
      CHANNELS.chat.sessions,
      CHANNELS.chat.getHistory,
      CHANNELS.chat.sessionHistory,
      CHANNELS.plugins.cards,
      CHANNELS.plugins.marketplaceList,
      PERMISSIONS.getMode,
      CHANNELS.usage.summary,
      CHANNELS.usage.range,
    ]);
    expect(calls.every((c) => c.origin === "local-api")).toBe(true);
  });

  it("carries the 'cli' origin when constructed for the CLI", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, data: { mode: "default" } }));
    const client = createLvisClient(api, "cli");
    expect(client.origin).toBe("cli");
    await client.getPermissionMode();
    expect(calls[0]).toMatchObject({ channel: PERMISSIONS.getMode, origin: "cli" });
  });

  it("returns the dispatcher's data on success", async () => {
    const { api } = fakeApi(() => ({ ok: true, data: { mode: "plan" } }));
    const client = createLvisClient(api, "local-api");
    await expect(client.getPermissionMode()).resolves.toEqual({ mode: "plan" });
  });
});

describe("LvisClient — fail-closed error propagation", () => {
  it("throws LvisClientError carrying the code + channel on rejection", async () => {
    const { api } = fakeApi(() => ({ ok: false, error: "channel-not-public" }));
    const client = createLvisClient(api, "local-api");
    await expect(client.listPlugins()).rejects.toBeInstanceOf(LvisClientError);
    await client.listPlugins().catch((err: unknown) => {
      expect(err).toBeInstanceOf(LvisClientError);
      const e = err as LvisClientError;
      expect(e.code).toBe("channel-not-public");
      expect(e.channel).toBe(CHANNELS.plugins.cards);
    });
  });
});

describe("LvisClient — integration over a real local-api (cli origin)", () => {
  const chatSendContext: ChatSendContext = {
    sink: () => {},
    allocateStreamId: () => 1,
    trackStreamTurn: (factory) => factory(),
  };

  function realDeps(): LocalApiDeps {
    const ipc = {
      conversationLoop: { getSessionId: () => "s", permissionManager: { getMode: () => "acceptEdits" } },
    } as unknown as IpcDeps;
    return { ipc, chatSendContext };
  }

  it("flows a public read (permission mode) through cli → dispatcher → handler", async () => {
    const client = createLvisClient(createLocalApi(realDeps()), "cli");
    await expect(client.getPermissionMode()).resolves.toEqual({ mode: "acceptEdits" });
  });
});
