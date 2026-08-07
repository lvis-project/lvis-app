/**
 * The `/load <partial-session-id>` lookup query, checked against the REAL
 * `lvis:chat:sessions` handler.
 *
 * The renderer's `/load` branch (src/ui/renderer/hooks/use-send-message.ts) and
 * the engine dispatcher (src/engine/turn/commands.ts) resolve the same partial
 * id. The renderer can only reach sessions through this handler, so the shared
 * `SESSION_ID_PREFIX_LOOKUP_QUERY` is only worth anything if the handler
 * actually honours it — that is what these tests pin. The renderer half (that
 * `/load` really sends this query, and really finds the rows it unlocks) is
 * pinned end-to-end in src/ui/renderer/__tests__/App-handle-ask.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import { handleChatSessions } from "../chat.js";
import {
  SESSION_ID_PREFIX_LOOKUP_QUERY,
  SESSION_LIST_MAX_LIMIT,
  findSessionByIdPrefix,
} from "../../../shared/session-lookup.js";

function depsWithListSpy(): {
  deps: IpcDeps;
  listSessionsPage: ReturnType<typeof vi.fn>;
} {
  const listSessionsPage = vi.fn(() => []);
  return {
    listSessionsPage,
    deps: {
      conversationLoop: { getSessionId: () => "session-1" },
      memoryManager: { listSessionsPage },
    } as unknown as IpcDeps,
  };
}

describe("session-id prefix lookup query vs the real chat-sessions handler", () => {
  it("reaches the store with every kind and the widest page the handler allows", () => {
    const { deps, listSessionsPage } = depsWithListSpy();

    handleChatSessions(deps, { ...SESSION_ID_PREFIX_LOOKUP_QUERY });

    expect(listSessionsPage).toHaveBeenCalledTimes(1);
    expect(listSessionsPage.mock.calls[0]?.[0]).toMatchObject({
      kind: "all",
      limit: SESSION_LIST_MAX_LIMIT,
    });
  });

  it("is strictly wider than the handler's own defaults", () => {
    // The pre-consolidation renderer passed NO options and silently inherited
    // these. If the handler defaults ever widen to match, this test says so.
    const { deps, listSessionsPage } = depsWithListSpy();

    handleChatSessions(deps, undefined);

    const defaults = listSessionsPage.mock.calls[0]?.[0] as {
      kind: string;
      limit: number;
    };
    expect(defaults.kind).toBe("main");
    expect(defaults.limit).toBe(20);
    expect(SESSION_ID_PREFIX_LOOKUP_QUERY.kind).not.toBe(defaults.kind);
    expect(SESSION_ID_PREFIX_LOOKUP_QUERY.limit).toBeGreaterThan(defaults.limit);
  });

  it("asks for exactly the limit the handler clamps to, never a trimmed one", () => {
    const { deps, listSessionsPage } = depsWithListSpy();

    handleChatSessions(deps, { limit: SESSION_LIST_MAX_LIMIT + 1_000 });

    expect(
      (listSessionsPage.mock.calls[0]?.[0] as { limit: number }).limit,
    ).toBe(SESSION_ID_PREFIX_LOOKUP_QUERY.limit);
  });
});

describe("findSessionByIdPrefix", () => {
  const sessions = [
    { id: "sess-alpha-1" },
    { id: "sess-alpha-2" },
    { id: "sess-beta-1" },
  ];

  it("returns the first session whose id starts with the prefix", () => {
    expect(findSessionByIdPrefix(sessions, "sess-alpha")?.id).toBe("sess-alpha-1");
    expect(findSessionByIdPrefix(sessions, "sess-beta-1")?.id).toBe("sess-beta-1");
  });

  it("does not match on a substring that is not a prefix", () => {
    expect(findSessionByIdPrefix(sessions, "alpha")).toBeUndefined();
  });

  it("never selects an arbitrary session for an empty or blank prefix", () => {
    expect(findSessionByIdPrefix(sessions, "")).toBeUndefined();
    expect(findSessionByIdPrefix(sessions, "   ")).toBeUndefined();
  });
});
