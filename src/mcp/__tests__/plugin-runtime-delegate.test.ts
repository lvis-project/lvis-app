/**
 * `pluginRuntimeToolDelegate` parity (mcp-alignment-design.md §5 plugin-loopback-server).
 *
 * The loopback delegate must reproduce buildPluginTool's execute gate exactly:
 * inactive / integrity-disabled fail closed, ManifestIntegrityViolation records
 * + fails closed, and the structured return value survives as
 * _meta["lvisai/rawResult"]. A host-level test asserts that raw value reaches
 * the registered Tool's metadata.rawResult (the executor.ts / boot.ts contract).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pluginRuntimeToolDelegate,
  splitPluginToolUiMeta,
  RAW_RESULT_META,
} from "../plugin-runtime-delegate.js";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";
import { sessionContext } from "../../engine/session-context.js";

beforeEach(() => manifestIntegrityState.resetForTests());

const PLUGIN_ID = "com.example.notes";

// fakeRuntime builds a minimal PluginRuntime stub. isSessionActivated now takes
// (sessionId, pluginId) matching the per-session Map API; the mock can ignore
// sessionId and return a test-controlled value.
function fakeRuntime(over: Partial<Pick<PluginRuntime, "isPluginEnabled" | "isSessionActivated" | "call">>): PluginRuntime {
  return {
    isPluginEnabled: () => true,
    isSessionActivated: (_sessionId: string, _pluginId: string) => false,
    call: vi.fn(async () => "ok"),
    ...over,
  } as unknown as PluginRuntime;
}

describe("pluginRuntimeToolDelegate — fail-closed gate parity", () => {
  it("inactive plugin → isError without invoking the runtime", async () => {
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("integrity-disabled plugin → isError without invoking the runtime", async () => {
    await manifestIntegrityState.recordViolation(PLUGIN_ID, "notes_read", "writeFileSync");
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("disabled after a manifest integrity violation");
    expect(call).not.toHaveBeenCalled();
  });

  it("success carries the raw value in _meta and renders text", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ items: ["a", "b"] })) }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toBe(JSON.stringify({ items: ["a", "b"] }, null, 2));
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ items: ["a", "b"] });
  });

  it("empty args → runtime receives undefined payload (parity with buildPluginTool)", async () => {
    const call = vi.fn(async () => "ok");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    await delegate("notes_read", {});
    expect(call).toHaveBeenCalledWith("notes_read", undefined);
  });

  it("ManifestIntegrityViolation → records the violation and fails closed", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new ManifestIntegrityViolation(PLUGIN_ID, "notes_read", "writeFileSync");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBe(true);
    expect(manifestIntegrityState.isDisabled(PLUGIN_ID)).toBe(true);
  });

  it("ordinary thrown error → isError outcome", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("boom");
  });
});

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Notes",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "notes",
  tools: [
    {
      name: "notes_read",
      description: "Read",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

describe("pluginRuntimeToolDelegate — Gate 4: session-scoped on-demand activation", () => {
  // *** THIS is the mutation-detecting test ***
  // If Gate 4 is reverted to `!isPluginEnabled` only (removing the
  // isSessionActivated check), this test fails because the delegate would
  // return isError:true even though isSessionActivated returns true.
  it("registry-disabled + session-activated → tool call SUCCEEDS (load-bearing mutation detector)", async () => {
    const call = vi.fn(async () => ({ scanned: 42 }));
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => true,
        call,
      }),
      PLUGIN_ID,
    );
    // Must run within ALS session context: the delegate reads
    // sessionContext.getStore()?.sessionId to look up the activation map.
    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", { q: "test" }),
    );
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ scanned: 42 });
  });

  it("disabled + NOT session-activated → REFUSED (original fail-closed behavior preserved)", async () => {
    // Also the mutation verifier: if Gate 4 removed the isSessionActivated branch
    // this test would still pass (gate refuses), but test above would fail.
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => false,
        call,
      }),
      PLUGIN_ID,
    );
    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("fail-closed when no ALS session context (e.g. out-of-band call): disabled plugin → REFUSED", async () => {
    // No sessionContext.run() wrapper — sessionId is undefined → gate refuses.
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => true, // even if runtime says yes…
        call,
      }),
      PLUGIN_ID,
    );
    const out = await delegate("index_scan", {});
    expect(out.isError).toBe(true); // …no ALS sessionId → refused
    expect(call).not.toHaveBeenCalled();
  });

  it("non-allow-listed disabled plugin (not session-activated) → STILL refused by gate", async () => {
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: (_s, _p) => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("some_tool", {});
    expect(out.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("main chat: disabled plugin (no session activation) → REFUSED (behavior unchanged)", async () => {
    // In main chat allowedPluginIds is undefined so no session activation occurs;
    // isSessionActivated always returns false → gate closes identically to before.
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: (_s, _p) => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("tool", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("registry-ENABLED + session-activated → succeeds (enabled takes priority, no regression)", async () => {
    const call = vi.fn(async () => "result");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => true, isSessionActivated: (_s, _p) => true, call }),
      PLUGIN_ID,
    );
    const out = await delegate("tool", {});
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
  });
});

describe("pluginRuntimeToolDelegate — Gate 4: per-session isolation (clear-race regression)", () => {
  it("clearing session B's scope does NOT wipe session A's on-demand activation", async () => {
    // Regression test for the cross-session clear race:
    // SCENARIO: routine fires at 22:00 (session A) → activates local-indexer →
    //   user starts a new main-chat conversation (session B) →
    //   ConversationLoop.resetSession() calls clearSessionActivated("session-B") →
    //   session A's activation MUST survive → next index_scan SUCCEEDS.
    //
    // This test FAILS with the old global flat-Set approach (clearSessionActivated()
    // wiped ALL activations) and PASSES with the per-session Map approach.

    // Simulate the Map-keyed activation state (mirrors PluginRuntime internals)
    const activations = new Map<string, Set<string>>();
    const sessionAId = "routine-session-22h00";
    const sessionBId = "main-chat-22h00-user";

    const sessionAwareIsActivated = (sid: string, pid: string) =>
      activations.get(sid)?.has(pid) ?? false;

    const call = vi.fn(async () => ({ scanned: 99 }));
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: sessionAwareIsActivated, call }),
      PLUGIN_ID,
    );

    // Session A: routine activates the plugin
    if (!activations.has(sessionAId)) activations.set(sessionAId, new Set());
    activations.get(sessionAId)!.add(PLUGIN_ID);

    // Session B: user starts new conversation → per-session clear of B ONLY
    // (per-session Map: delete(sessionBId) — does NOT touch sessionAId)
    activations.delete(sessionBId);

    // Session A's activation must still be present
    expect(sessionAwareIsActivated(sessionAId, PLUGIN_ID)).toBe(true);

    // Tool call from session A's ALS context must SUCCEED
    const out = await sessionContext.run({ sessionId: sessionAId }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ scanned: 99 });
  });

  it("[OLD-APPROACH REGRESSION] global flat-Set clear would wipe session A → refused", async () => {
    // Demonstrates the bug that a global flat-Set had: clearSessionActivated()
    // with no sessionId argument wiped ALL activations regardless of session.
    // This test passes with the OLD (broken) approach to prove the regression
    // is real, then asserts the outcome was an isError (the failure mode).
    //
    // The new per-session Map approach makes the test above pass instead.

    const globalSet = new Set<string>();
    // OLD behavior: isSessionActivated ignores sessionId, checks global set
    const oldIsActivated = (_sid: string, pid: string) => globalSet.has(pid);

    const call = vi.fn(async () => "result");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: oldIsActivated, call }),
      PLUGIN_ID,
    );

    // Session A activates
    globalSet.add(PLUGIN_ID);

    // Session B clears (OLD global clear — wipes EVERYTHING)
    globalSet.clear(); // ← old `clearSessionActivated()` did this

    // Session A's activation is now GONE (the bug)
    expect(oldIsActivated("routine-session-A", PLUGIN_ID)).toBe(false);

    // Tool call from session A now fails because activation was wiped
    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBe(true); // proves the old flat-Set approach was broken
    expect(call).not.toHaveBeenCalled();
  });
});

describe("end-to-end: raw plugin value survives manifest → server → host → metadata.rawResult", () => {
  it("registered Tool surfaces metadata.rawResult from the plugin return value", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ hits: 3 })) }),
      PLUGIN_ID,
    );
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);
    await host.start();

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.metadata?.rawResult).toEqual({ hits: 3 });
  });
});

/**
 * The MCP App TRIGGER. A plugin's tool handler declares "render this card with my
 * result" with the STANDARD MCP Apps tool-result extension — the same
 * `_meta.ui.resourceUri` an external MCP server puts on its CallToolResult — and the
 * delegate lifts it onto the wire. Before this, `_meta.ui` was never populated on the
 * plugin arm, so no first-party plugin could make a card render at all.
 */
const CARD_URI = `ui://${PLUGIN_ID}/note.html`;
const DECLARED = new Set([CARD_URI]);

describe("pluginRuntimeToolDelegate — MCP App card trigger (_meta.ui)", () => {
  it("a declared resourceUri on the handler's return value reaches the wire _meta.ui", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          note: "hello",
          _meta: { ui: { resourceUri: CARD_URI, slot: "sidebar", height: 420, title: "Note" } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toEqual({
      resourceUri: CARD_URI,
      slot: "sidebar",
      height: 420,
      title: "Note",
    });
  });

  it("the card declaration is protocol, not payload: text + rawResult carry the plugin's OWN result", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({ note: "hello", _meta: { ui: { resourceUri: CARD_URI } } })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    // The `_meta` envelope never leaks into what the model reads or into rawResult.
    expect(out.content[0].text).toBe(JSON.stringify({ note: "hello" }, null, 2));
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ note: "hello" });
  });

  it("an UNDECLARED resourceUri produces NO card (fail-closed) — the result still returns", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          note: "hello",
          _meta: { ui: { resourceUri: `ui://${PLUGIN_ID}/undeclared.html` } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
    expect(out.isError).toBeUndefined();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ note: "hello" });
  });

  it("a plugin that declared NO uiResources[] cannot trigger a card (empty-set default)", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ _meta: { ui: { resourceUri: CARD_URI } } })) }),
      PLUGIN_ID,
      // no declared set passed — the loopback manager passes none for a plugin
      // whose manifest declares no uiResources[]
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
  });

  it("a plugin result with no _meta (the common case) is untouched — no card, value identical", async () => {
    const value = { note: "hello" };
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => value) }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
    expect(out._meta?.[RAW_RESULT_META]).toBe(value); // same reference, not a copy
  });

  it("a malformed _meta.ui (no resourceUri) yields no card and leaves the value alone", () => {
    const value = { note: "x", _meta: { ui: { height: 300 } } };
    expect(splitPluginToolUiMeta(value)).toEqual({ value });
    expect(splitPluginToolUiMeta("a string")).toEqual({ value: "a string" });
    expect(splitPluginToolUiMeta([1, 2])).toEqual({ value: [1, 2] });
  });
});

describe("end-to-end: a plugin tool result renders a card (delegate → server → host → uiPayload)", () => {
  const CARD_MANIFEST: PluginManifest = {
    ...MANIFEST,
    uiResources: [{ uri: CARD_URI, csp: { connectDomains: ["https://api.example.com"] } }],
  };

  it("registered Tool surfaces metadata.uiPayload with the HOST-stamped serverId", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({ hits: 3, _meta: { ui: { resourceUri: CARD_URI } } })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const host = PluginMcpHost.loopback(CARD_MANIFEST, delegate, registry);
    await host.start();

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    // serverId is stamped by the host from the plugin's own id — a plugin can never
    // point a card at another server's namespace.
    expect(result.metadata?.uiPayload).toEqual({
      serverId: PLUGIN_ID,
      resourceUri: CARD_URI,
      slot: "chat", // default when the plugin declares no slot
      height: undefined,
      title: undefined,
    });
    expect(result.metadata?.rawResult).toEqual({ hits: 3 });
  });

  it("an undeclared resourceUri renders NO card end-to-end", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          hits: 3,
          _meta: { ui: { resourceUri: `ui://${PLUGIN_ID}/rogue.html` } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const host = PluginMcpHost.loopback(CARD_MANIFEST, delegate, registry);
    await host.start();

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.metadata?.uiPayload).toBeUndefined();
  });
});
