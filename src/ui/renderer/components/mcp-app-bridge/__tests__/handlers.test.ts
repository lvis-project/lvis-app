// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOnSandboxReady,
  createOnReadResource,
  createOnOpenLink,
  createOnSizeChange,
  createOnCallTool,
  createOnMessage,
  createOnRequestDisplayMode,
  createOnDownloadFile,
  createOnUpdateModelContext,
} from "../handlers.js";
import type { McpUiToolCallOutcome } from "../../../../../mcp/types.js";
import type { McpUiMessageOutcome } from "../../../../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../../../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../../../../mcp/mcp-app-model-context.js";
import {
  MCP_APP_AVAILABLE_DISPLAY_MODES,
  type McpUiDisplayMode,
} from "../../../../../shared/mcp-app-display-mode.js";

describe("createOnSandboxReady", () => {
  it("answers the ready notification with the app document — html only, no sandbox field", () => {
    const sendSandboxResourceReady = vi.fn();
    const handler = createOnSandboxReady({
      bridge: { sendSandboxResourceReady },
      html: "<html><body>card</body></html>",
    });

    (handler as () => void)();

    expect(sendSandboxResourceReady).toHaveBeenCalledTimes(1);
    // The relay preload owns the inner iframe's sandbox attribute; sending a wire
    // `sandbox` value would be dead data, so the payload is html-only.
    expect(sendSandboxResourceReady.mock.calls[0]![0]).toEqual({
      html: "<html><body>card</body></html>",
    });
  });
});

describe("createOnReadResource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies resources/read to window.lvis.mcp.readUiResource and wraps the html as an mcp-app resource", async () => {
    const readUiResource = vi.fn(async () => ({ html: "<html><body>card</body></html>" }));
    vi.stubGlobal("lvis", { mcp: { readUiResource } });

    const handler = createOnReadResource({ serverId: "github" }) as (
      p: { uri: string },
    ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;

    const result = await handler({ uri: "ui://card/1" });

    // The serverId is bound at wire time; the app supplies only the uri.
    expect(readUiResource).toHaveBeenCalledWith("github", "ui://card/1");
    expect(result).toEqual({
      contents: [
        {
          uri: "ui://card/1",
          mimeType: "text/html;profile=mcp-app",
          text: "<html><body>card</body></html>",
        },
      ],
    });
  });

  it("REFUSES any non-ui:// uri before the IPC (fail closed)", async () => {
    const readUiResource = vi.fn(async () => ({ html: "" }));
    vi.stubGlobal("lvis", { mcp: { readUiResource } });

    const handler = createOnReadResource({ serverId: "github" }) as (
      p: { uri: unknown },
    ) => Promise<unknown>;

    // The uri is the ONE value the app supplies. Anything outside the card surface —
    // another resource family on the same server, a file, an http(s) URL — is refused, and
    // never reaches the read chokepoint (whose every call also mints a proxy-session token
    // from a bounded LRU, so a read loop would evict other live cards' tokens).
    for (const uri of [
      "file:///etc/passwd",
      "https://evil.example/x",
      "resource://secret/1",
      "UI://card/1",
      "",
      undefined,
      42,
    ]) {
      await expect(handler({ uri }), `uri=${String(uri)}`).rejects.toThrow(/ui:\/\//);
    }
    expect(readUiResource).not.toHaveBeenCalled();
  });
});

/** Invoke the open-link handler ignoring the unused `RequestHandlerExtra` second arg. */
function invokeOpenLink(handler: ReturnType<typeof createOnOpenLink>, url: string) {
  return (handler as (p: { url: string }) => Promise<{ isError?: boolean }>)({ url });
}

describe("createOnOpenLink", () => {
  it("returns {} (opened) when the gated opener accepted the URL", async () => {
    const openLink = vi.fn(async () => ({ ok: true }));
    const handler = createOnOpenLink({ openLink });

    const result = await invokeOpenLink(handler, "https://example.com");

    expect(openLink).toHaveBeenCalledWith("https://example.com");
    expect(result).toEqual({});
  });

  it("returns { isError: true } when the host declined the URL", async () => {
    const openLink = vi.fn(async () => ({ ok: false }));
    const handler = createOnOpenLink({ openLink });

    const result = await invokeOpenLink(handler, "file:///etc/passwd");

    expect(openLink).toHaveBeenCalledWith("file:///etc/passwd");
    expect(result).toEqual({ isError: true });
  });
});

describe("createOnSizeChange", () => {
  it("forwards both dimensions to the injected onResize sink", () => {
    const onResize = vi.fn();
    const handler = createOnSizeChange({ onResize });

    handler({ width: 640, height: 480 });

    expect(onResize).toHaveBeenCalledWith({ width: 640, height: 480 });
  });

  it("forwards a height-only notification (width undefined) verbatim", () => {
    const onResize = vi.fn();
    const handler = createOnSizeChange({ onResize });

    handler({ height: 512 });

    expect(onResize).toHaveBeenCalledWith({ width: undefined, height: 512 });
  });
});

type CallToolParams = { name: string; arguments?: Record<string, unknown> };
type CallToolHandler = (p: CallToolParams) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildCallTool(outcome: McpUiToolCallOutcome | Error) {
  const callTool = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { callTool, handler: createOnCallTool({ callTool }) as unknown as CallToolHandler };
}

describe("createOnCallTool — the app never names a server", () => {
  it("forwards ONLY the tool name + args to the serverId-bound invoker", async () => {
    const { callTool, handler } = buildCallTool({ ok: true, result: "done" });

    await handler({ name: "acme_open", arguments: { id: 7 } });

    // No serverId in the app's params, and none in what the handler passes on: the
    // binding was made by McpAppView from the card payload.
    expect(callTool).toHaveBeenCalledWith("acme_open", { id: 7 });
  });

  it("defaults missing arguments to an empty object", async () => {
    const { callTool, handler } = buildCallTool({ ok: true, result: "" });
    await handler({ name: "acme_status" });
    expect(callTool).toHaveBeenCalledWith("acme_status", {});
  });
});

describe("createOnCallTool — CallToolResult shaping", () => {
  it("returns a text CallToolResult for a string result", async () => {
    const { handler } = buildCallTool({ ok: true, result: "hello" });
    await expect(handler({ name: "t" })).resolves.toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("serializes a structured result into a text block", async () => {
    const { handler } = buildCallTool({ ok: true, result: { count: 2 } });
    await expect(handler({ name: "t" })).resolves.toEqual({
      content: [{ type: "text", text: '{"count":2}' }],
    });
  });
});

describe("createOnCallTool — denials come back as MCP error RESULTS, never as throws", () => {
  it("renders a host denial as { isError: true } with the reason", async () => {
    const { handler } = buildCallTool({
      ok: false,
      error: "cross-server-call-denied",
      message: "Tool 'x' is not owned by MCP server 'acme-cards'",
    });

    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool 'x' is not owned by MCP server 'acme-cards'" }],
    });
  });

  it("falls back to the error CODE when main sent no message", async () => {
    const { handler } = buildCallTool({ ok: false, error: "unauthorized-frame" });
    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "unauthorized-frame" }],
    });
  });

  it("renders even an IPC transport failure as an error result (bridge request never rejects)", async () => {
    const { handler } = buildCallTool(new Error("ipc exploded"));
    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "ipc exploded" }],
    });
  });
});

type MessageParams = { role: "user"; content: Array<{ type: string; text?: string }> };
type MessageHandler = (p: MessageParams) => Promise<{ isError?: boolean }>;

function buildMessage(outcome: McpUiMessageOutcome | Error) {
  const postMessage = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { postMessage, handler: createOnMessage({ postMessage }) as unknown as MessageHandler };
}

const messageParams: MessageParams = {
  role: "user",
  content: [{ type: "text", text: "hello host" }],
};

describe("createOnMessage — the app names neither a server nor a session", () => {
  it("forwards ONLY the spec params to the bound poster", async () => {
    const { postMessage, handler } = buildMessage({ ok: true, disposition: "queued" });

    await handler(messageParams);

    // serverId + sessionId are absent here: McpAppView bound both from the card.
    expect(postMessage).toHaveBeenCalledWith(messageParams);
  });
});

describe("createOnMessage — the result never carries conversation content", () => {
  it("accepts with an EMPTY result, whatever the host did with the message", async () => {
    for (const disposition of ["queued", "staged", "notified"] as const) {
      const { handler } = buildMessage({ ok: true, disposition });
      await expect(handler(messageParams)).resolves.toEqual({});
    }
  });

  it("rejects with `{ isError: true }` and nothing else", async () => {
    const { handler } = buildMessage({ ok: false, error: "rate-limited", message: "too many messages" });

    const result = await handler(messageParams);

    expect(result).toEqual({ isError: true });
    // Not even the host's own reason leaks back into the app frame.
    expect(JSON.stringify(result)).not.toContain("rate-limited");
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an error RESULT, not a throw", async () => {
    const { handler } = buildMessage(new Error("unauthorized-frame"));

    await expect(handler(messageParams)).resolves.toEqual({ isError: true });
  });
});

type DisplayModeHandler = (p: { mode: string }) => Promise<{ mode: McpUiDisplayMode }>;

/** A card sitting in `current`, whose applier always succeeds. */
function buildDisplayMode(current: McpUiDisplayMode, applied?: McpUiDisplayMode) {
  let mode = current;
  const applyMode = vi.fn(async (next: McpUiDisplayMode) => {
    // `applied` models a host that could not honour the request and stayed put.
    mode = applied ?? next;
    return mode;
  });
  const getMode = vi.fn(() => mode);
  return {
    applyMode,
    getMode,
    handler: createOnRequestDisplayMode({ getMode, applyMode }) as unknown as DisplayModeHandler,
  };
}

describe("createOnRequestDisplayMode — the result is the mode ACTUALLY applied", () => {
  it("applies an advertised mode and answers with it", async () => {
    const { handler, applyMode } = buildDisplayMode("inline");

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "fullscreen" });
    expect(applyMode).toHaveBeenCalledWith("fullscreen");
  });

  it("answers with the APPLIED mode, not the requested one, when the host stayed put", async () => {
    // For example, the store guard declined the move and the card stayed inline.
    const { handler } = buildDisplayMode("inline", "inline");

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "inline" });
  });

  it("returns the CURRENT mode (never a throw) when the applier fails", async () => {
    const getMode = vi.fn((): McpUiDisplayMode => "inline");
    const applyMode = vi.fn(async () => {
      throw new Error("unauthorized-frame");
    });
    const handler = createOnRequestDisplayMode({ getMode, applyMode }) as unknown as DisplayModeHandler;

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "inline" });
  });
});

describe("createOnRequestDisplayMode — an unadvertised mode is refused, once, here", () => {
  // `pip` is now IN the advertised set (a renderer-side location store makes it real —
  // see `mcp-app-card-location-store.ts`), so a `pip` request is FORWARDED to
  // `applyMode` like any other advertised mode; it is exercised by the "honours exactly
  // the advertised set" test below, which is drift-safe against the SoT rather than
  // hardcoding a specific example. This handler-level module has no opinion on WHICH
  // renderer location can actually honour a `pip` request — that decision lives
  // in `applyMode` itself (McpAppView), not here.

  it("refuses garbage a non-conforming app could send", async () => {
    const { handler, applyMode } = buildDisplayMode("inline");

    for (const mode of ["", "INLINE", "windowed", "../../etc"]) {
      await expect(handler({ mode })).resolves.toEqual({ mode: "inline" });
    }
    expect(applyMode).not.toHaveBeenCalled();
  });

  it("honours exactly the advertised set — the same SoT the host context publishes", async () => {
    for (const mode of MCP_APP_AVAILABLE_DISPLAY_MODES) {
      const { handler, applyMode } = buildDisplayMode("inline");
      await expect(handler({ mode })).resolves.toEqual({ mode });
      if (mode !== "inline") expect(applyMode).toHaveBeenCalledWith(mode);
    }
  });
});

type DownloadParams = { contents: Array<Record<string, unknown>> };
type DownloadHandler = (p: DownloadParams) => Promise<{ isError?: boolean }>;

function buildDownload(outcome: McpUiDownloadOutcome | Error) {
  const downloadFile = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { downloadFile, handler: createOnDownloadFile({ downloadFile }) as unknown as DownloadHandler };
}

const downloadParams: DownloadParams = {
  contents: [{ type: "resource", resource: { uri: "ui://card/a.csv", text: "a,b" } }],
};

describe("createOnDownloadFile — the app names no server and gets no reason back", () => {
  it("forwards ONLY the spec params to the bound sink", async () => {
    const { downloadFile, handler } = buildDownload({ ok: true, disposition: "saved" });

    await handler(downloadParams);

    // No serverId here: McpAppView bound it from the card.
    expect(downloadFile).toHaveBeenCalledWith(downloadParams);
  });

  it("saved → an EMPTY result", async () => {
    const { handler } = buildDownload({ ok: true, disposition: "saved" });

    await expect(handler(downloadParams)).resolves.toEqual({});
  });

  it("a user CANCEL is NOT an error — `{}`, never `{ isError: true }`", async () => {
    const { handler } = buildDownload({ ok: true, disposition: "cancelled" });

    const result = await handler(downloadParams);

    // Declining to save is not a failure: raising isError would tell the app to retry
    // or report a problem that never happened.
    expect(result).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  it("a host rejection → `{ isError: true }` and nothing else", async () => {
    const { handler } = buildDownload({
      ok: false,
      error: "resource-link-unsupported",
      message: "the host does not fetch app-supplied URIs",
    });

    const result = await handler(downloadParams);

    expect(result).toEqual({ isError: true });
    // Not even the host's reason leaks back into the app frame.
    expect(JSON.stringify(result)).not.toContain("resource-link");
  });

  it("an over-cap payload → `{ isError: true }`", async () => {
    const { handler } = buildDownload({ ok: false, error: "too-large", message: "download exceeds cap" });

    await expect(handler(downloadParams)).resolves.toEqual({ isError: true });
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an error RESULT, not a throw", async () => {
    const { handler } = buildDownload(new Error("unauthorized-frame"));

    await expect(handler(downloadParams)).resolves.toEqual({ isError: true });
  });
});

type ContextParams = { content?: unknown; structuredContent?: unknown };
type ContextHandler = (p: ContextParams) => Promise<Record<string, unknown>>;

function buildModelContext(outcome: McpUiModelContextOutcome | Error) {
  const updateModelContext = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return {
    updateModelContext,
    handler: createOnUpdateModelContext({ updateModelContext }) as unknown as ContextHandler,
  };
}

const contextParams: ContextParams = {
  content: [{ type: "text", text: "cart: 3 items" }],
  structuredContent: { items: 3 },
};

describe("createOnUpdateModelContext — the app names no server, session, or card", () => {
  it("forwards ONLY the spec params to the bound sink", async () => {
    const { updateModelContext, handler } = buildModelContext({ ok: true, disposition: "stored" });

    await handler(contextParams);

    // serverId + sessionId + cardId are absent: McpAppView bound all three.
    expect(updateModelContext).toHaveBeenCalledWith(contextParams);
  });
});

describe("createOnUpdateModelContext — the result is an EmptyResult, always", () => {
  it("stored → `{}`", async () => {
    const { handler } = buildModelContext({ ok: true, disposition: "stored" });

    await expect(handler(contextParams)).resolves.toEqual({});
  });

  it("a host REFUSAL is still `{}` — the spec gives this request no error channel", async () => {
    // An over-cap body is an audit fact, not a protocol one. We neither invent an
    // `isError` the spec does not define nor reject the bridge request.
    const { handler } = buildModelContext({ ok: false, error: "too-large", message: "context exceeds cap" });

    const result = await handler(contextParams);

    expect(result).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  it("a stale-session drop is `{}` too", async () => {
    const { handler } = buildModelContext({ ok: false, error: "session-mismatch", message: "not the active conversation" });

    await expect(handler(contextParams)).resolves.toEqual({});
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an EmptyResult, not a throw", async () => {
    const { handler } = buildModelContext(new Error("unauthorized-frame"));

    await expect(handler(contextParams)).resolves.toEqual({});
  });
});
