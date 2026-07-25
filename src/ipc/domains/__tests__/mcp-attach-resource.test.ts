/**
 * `lvis:mcp:attach-resource` — the user path's IPC.
 *
 * What this channel must guarantee:
 *   - an unauthorized sender frame is rejected BEFORE anything reaches a server
 *   - the HOST builds the fence; the renderer receives a ready-to-attach part and
 *     assembles nothing, because server text lands beside the user's own words
 *   - it never starts a turn: the outcome is an attachment the renderer must send
 *   - a URI shape the host would not catalogue is refused before the request
 *   - failures fail closed with a sanitized code (no server message, no host path)
 *   - per-server rate limiting applies (it reaches a server on the user's behalf)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { USER_PROMPT_RATE_LIMIT_MAX_CALLS } from "../../../boot/steps/plugin-runtime/trigger-gate.js";
import {
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
} from "../../../shared/mcp-resource-template-bounds.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

const CHANNEL = "lvis:mcp:attach-resource";
const invoke = makeAppIpcInvoker(handlers);

async function setup(
  readDeclaredResource?: ReturnType<typeof vi.fn>,
  readDeclaredResourceTemplate?: ReturnType<typeof vi.fn>,
) {
  handlers.clear();
  vi.clearAllMocks();
  // Fresh serverId per test — the rate limiter is a module singleton.
  const serverId = `hr-mcp-${Math.random().toString(36).slice(2, 10)}`;
  const readMock =
    readDeclaredResource ??
    vi.fn(async () => ({
      blocks: [{ uri: "file:///policy.md", mimeType: "text/markdown", text: "POLICY BODY" }],
      droppedBlocks: 0,
      truncated: false,
    }));
  // The template read returns the URI MAIN produced — the manager's contract, and what
  // the fence header and the audit row are keyed on.
  const templateReadMock =
    readDeclaredResourceTemplate ??
    vi.fn(async () => ({
      blocks: [{ uri: "file:///project/a.md", mimeType: "text/markdown", text: "TEMPLATE BODY" }],
      droppedBlocks: 0,
      truncated: false,
      uri: "file:///project/a.md",
    }));

  const deps = {
    pluginRuntime: { getPerfStats: vi.fn(() => ({})) },
    pluginLoopbackManager: { has: vi.fn(() => true), readUiResource: vi.fn() },
    mcpManager: {
      readUiResource: vi.fn(),
      listServers: vi.fn(() => []),
      listDeclaredResources: vi.fn(() => []),
      namespacedToolName: vi.fn(),
      getPrompt: vi.fn(),
      readDeclaredResource: readMock,
      listDeclaredResourceTemplates: vi.fn(() => []),
      readDeclaredResourceTemplate: templateReadMock,
    },
    toolRegistry: { size: 0, findByName: vi.fn() },
    getPluginToolInvoker: () => vi.fn(),
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger: { log: vi.fn() },
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginNotifications: vi.fn(),
    conversationLoop: { getSessionId: vi.fn(() => "session-live"), queueGuidance: vi.fn() },
    notificationService: { fire: vi.fn() },
    getMainWindow: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
    })),
    getAppWindows: vi.fn(() => []),
  };

  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, serverId, readMock, templateReadMock };
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:mcp:attach-resource — sender gate", () => {
  it("rejects an unauthorized sender frame before reaching the server", async () => {
    const { serverId, readMock } = await setup();
    const handler = handlers.get(CHANNEL)!;
    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      "file:///policy.md",
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:attach-resource — outcome", () => {
  it("returns a host-built fenced attachment, ready to send verbatim", async () => {
    const { serverId, readMock } = await setup();
    const result = (await invoke(CHANNEL, serverId, "file:///policy.md")) as {
      ok: boolean;
      attachment: { type: string; text: string };
    };
    expect(result.ok).toBe(true);
    expect(result.attachment.type).toBe("text");
    // The renderer assembles nothing: the fence, the untrusted framing, and the
    // provenance are all in the string the host returned.
    expect(result.attachment.text.startsWith('<mcp-resource trust="untrusted-server-data"')).toBe(true);
    expect(result.attachment.text).toContain(`server="${serverId}"`);
    expect(result.attachment.text).toContain("POLICY BODY");
    expect(result.attachment.text.endsWith("</mcp-resource>")).toBe(true);
    expect(readMock).toHaveBeenCalledWith(serverId, "file:///policy.md");
  });

  it("refuses a URI shape the host would never catalogue, before any request", async () => {
    const { serverId, readMock } = await setup();
    for (const uri of [
      "ui://widget/main.html", // the MCP-Apps serving path — different containment
      "javascript:alert(1)",
      "no-scheme",
      "",
      42,
    ]) {
      const result = await invoke(CHANNEL, serverId, uri);
      expect(result, String(uri).slice(0, 32)).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  // Shape-checked BEFORE the rate bucket and the audit line, as `getPrompt` does: an
  // unbounded serverId becomes a permanent key in a shared limiter map and lands
  // un-sliced in audit rows.
  it("refuses a serverId that cannot be a server id", async () => {
    const { readMock } = await setup();
    for (const bad of ["bad id with spaces", "s".repeat(500), "-leading-dash", ""]) {
      const result = await invoke(CHANNEL, bad, "file:///policy.md");
      expect(result, bad.slice(0, 24)).toEqual({ ok: false, error: "invalid-server-id" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  it("fails closed on an empty render and on a server error", async () => {
    const empty = await setup(vi.fn(async () => ({ blocks: [], droppedBlocks: 0, truncated: false })));
    expect(await invoke(CHANNEL, empty.serverId, "file:///x")).toEqual({
      ok: false,
      error: "empty-resource",
    });

    const boom = await setup(
      vi.fn(async () => {
        throw new Error("ENOENT: C:/Users/secret/path leaked");
      }),
    );
    const failed = (await invoke(CHANNEL, boom.serverId, "file:///x")) as { ok: boolean; error: string };
    expect(failed).toEqual({ ok: false, error: "resource-failed" });
    // The server's message never reaches the renderer.
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("reports a clip rather than presenting a partial resource as whole", async () => {
    const { serverId } = await setup(
      vi.fn(async () => ({
        blocks: [{ text: "HEAD" }, { omittedKind: "binary" }],
        droppedBlocks: 3,
        truncated: true,
      })),
    );
    const result = (await invoke(CHANNEL, serverId, "file:///x")) as {
      truncated: boolean;
      omittedBlocks: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.omittedBlocks).toBe(1);
  });

  // Two properties in one, because a single-key fixture proves only that SOME limit
  // exists — not that it is keyed by server, which is the whole point of the bucket.
  // The second half pins the deliberate sharing with `getPrompt`: both are round-trips
  // the user asked for against one server, and what the budget protects is that server
  // from a renderer looping on the user's behalf.
  it("rate limits per server, and shares the budget with prompts/get", async () => {
    const { deps, serverId } = await setup();
    const other = `${serverId}-other`;

    let limited = false;
    for (let i = 0; i <= USER_PROMPT_RATE_LIMIT_MAX_CALLS; i += 1) {
      const result = (await invoke(CHANNEL, serverId, "file:///x")) as { error?: string };
      if (result.error === "rate-limited") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    // A different server is untouched — one chatty surface cannot starve another.
    expect(await invoke(CHANNEL, other, "file:///x")).toMatchObject({ ok: true });

    // …and the prompt surface on the SPENT server is limited by the same bucket,
    // without ever reaching the server.
    const promptResult = await invoke("lvis:mcp:get-prompt", serverId, "summarize", {});
    expect(promptResult).toMatchObject({ ok: false, error: "rate-limited" });
    expect(deps.mcpManager.getPrompt).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:list-resources — the picker's catalogue", () => {
  it("returns the host's ONE projection, not a re-derived list", async () => {
    const { deps } = await setup();
    const catalogue = [
      { serverId: "hr-mcp", resources: [{ uri: "file:///policy.md", name: "policy.md" }] },
    ];
    deps.mcpManager.listDeclaredResources.mockReturnValue(catalogue);

    const result = await invoke("lvis:mcp:list-resources");

    // Verbatim from `listDeclaredResources`, which is what stops the picker offering a
    // URI the read path would then refuse as undeclared.
    expect(result).toEqual({ ok: true, servers: catalogue });
    expect(deps.mcpManager.listDeclaredResources).toHaveBeenCalled();
  });

  it("rejects an unauthorized sender frame", async () => {
    const { deps } = await setup();
    const handler = handlers.get("lvis:mcp:list-resources")!;
    const result = await handler({ senderFrame: { url: "https://evil.example.com/x" } } as never);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(deps.mcpManager.listDeclaredResources).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:list-resource-templates — the offers half of the catalogue", () => {
  it("returns the host's template projection verbatim", async () => {
    const { deps } = await setup();
    const catalogue = [
      {
        serverId: "hr-mcp",
        templates: [
          { uriTemplate: "file:///project/{path}", name: "Project file", variables: ["path"] },
        ],
      },
    ];
    deps.mcpManager.listDeclaredResourceTemplates.mockReturnValue(catalogue as never);

    expect(await invoke("lvis:mcp:list-resource-templates")).toEqual({
      ok: true,
      servers: catalogue,
    });
  });

  it("rejects an unauthorized sender frame", async () => {
    const { deps } = await setup();
    const handler = handlers.get("lvis:mcp:list-resource-templates")!;
    const result = await handler({ senderFrame: { url: "https://evil.example.com/x" } } as never);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(deps.mcpManager.listDeclaredResourceTemplates).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:attach-resource-template — filling an offer", () => {
  const TEMPLATE_CHANNEL = "lvis:mcp:attach-resource-template";

  it("rejects an unauthorized sender frame before reaching the server", async () => {
    const { serverId, templateReadMock } = await setup();
    const handler = handlers.get(TEMPLATE_CHANNEL)!;
    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      "file:///project/{path}",
      { path: "a.md" },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  it("passes the TEMPLATE and a Map of values, and fences what main read", async () => {
    const { serverId, templateReadMock } = await setup();
    const result = (await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: "a.md",
    })) as { ok: boolean; uri: string; attachment: { text: string } };

    expect(result.ok).toBe(true);
    // A `Map`, never a `Record` — the property the prompt-arguments dialog states, held
    // on the main side too, because this one is built from renderer input.
    const [, template, values] = templateReadMock.mock.calls[0] as [string, string, unknown];
    expect(template).toBe("file:///project/{path}");
    expect(values).toBeInstanceOf(Map);
    expect((values as Map<string, string>).get("path")).toBe("a.md");
    // Keyed on the URI MAIN produced, not on anything the renderer sent.
    expect(result.uri).toBe("file:///project/a.md");
    expect(result.attachment.text).toContain('uri="file:///project/a.md"');
    expect(result.attachment.text).toContain("TEMPLATE BODY");
  });

  it("refuses a template shape the host would never catalogue, before any request", async () => {
    const { serverId, templateReadMock } = await setup();
    for (const uriTemplate of [
      "file:///project/{+path}", // reserved expansion — the traversal operator
      "file:///project/{path*}",
      "ui://widget/{id}",
      "file:///project/README.md", // a concrete URI is not a template
      "javascript:alert({x})",
      "",
      42,
    ]) {
      const result = await invoke(TEMPLATE_CHANNEL, serverId, uriTemplate, { path: "a.md" });
      expect(result, String(uriTemplate).slice(0, 32)).toEqual({
        ok: false,
        error: "invalid-request",
      });
    }
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  it("refuses a serverId that cannot be a server id", async () => {
    const { templateReadMock } = await setup();
    for (const bad of ["bad id with spaces", "s".repeat(500), "-leading-dash", ""]) {
      const result = await invoke(TEMPLATE_CHANNEL, bad, "file:///project/{path}", {});
      expect(result, bad.slice(0, 24)).toEqual({ ok: false, error: "invalid-server-id" });
    }
    expect(templateReadMock).not.toHaveBeenCalled();
  });

  // A variable named `__proto__` is a name the form would happily render and the user
  // would happily fill. In a `Record` it reaches the prototype setter; in the `Map` main
  // builds it is an ordinary key — and the value survives to the expansion either way,
  // which is the part a "we filtered it out" implementation would silently lose.
  it("carries a prototype-shaped variable name as an ordinary key", async () => {
    const { serverId, templateReadMock } = await setup();
    // Built with `JSON.parse`, not an object literal: `{ __proto__: … }` is the
    // prototype-setter SYNTAX and defines no own property, so a literal fixture here
    // would assert nothing while looking like it asserted the whole point. What arrives
    // over IPC is a structured clone of renderer data, which does carry `__proto__` as
    // an ordinary own key — this is that.
    const values = JSON.parse('{"__proto__":"PAYLOAD","toString":"SECOND"}') as
      Record<string, string>;
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{__proto__}/{toString}", values);
    const carried = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    // A plain `{}` accumulator swallows the first one (it reaches the prototype setter)
    // and shadows an inherited method with the second. The Map has neither problem, and
    // the user's value survives to the expansion — which is what they filled in.
    expect(carried.get("__proto__")).toBe("PAYLOAD");
    expect(carried.get("toString")).toBe("SECOND");
    expect(Object.getPrototypeOf(carried)).toBe(Map.prototype);
  });

  it("drops keys no catalogued template could have declared, and bounds the rest", async () => {
    const { serverId, templateReadMock } = await setup();
    const overLong = "v".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS + 50);
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: overLong,
      "not a name": "dropped",
      "": "dropped",
      nested: { toString: () => "not a string" },
    });
    const values = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect(values.get("path")).toHaveLength(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS);
    expect([...values.keys()]).toEqual(["path"]);
  });

  it("bounds how many variables one request may carry", async () => {
    const { serverId, templateReadMock } = await setup();
    const many = Object.fromEntries(
      Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES + 5 }, (_, i) => [`v${i}`, "x"]),
    );
    await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", many);
    const values = (templateReadMock.mock.calls[0] as [string, string, Map<string, string>])[2];
    expect(values.size).toBe(MCP_RESOURCE_TEMPLATE_MAX_VARIABLES);
  });

  it("fails closed on an empty read and on a server error", async () => {
    const empty = await setup(
      undefined,
      vi.fn(async () => ({
        blocks: [],
        droppedBlocks: 0,
        truncated: false,
        uri: "file:///project/a.md",
      })),
    );
    expect(
      await invoke(TEMPLATE_CHANNEL, empty.serverId, "file:///project/{path}", { path: "a.md" }),
    ).toEqual({ ok: false, error: "empty-resource" });

    const boom = await setup(
      undefined,
      vi.fn(async () => {
        throw new Error("ENOENT: C:/Users/secret/path leaked");
      }),
    );
    const failed = await invoke(TEMPLATE_CHANNEL, boom.serverId, "file:///project/{path}", {
      path: "a.md",
    });
    expect(failed).toEqual({ ok: false, error: "resource-failed" });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  // The same bucket as the plain attach and `prompts/get`: one server, one budget for
  // round-trips the user asked for. A separate bucket here would be a second budget a
  // renderer could spend against the same server.
  it("shares the user-initiated rate bucket with the plain attach", async () => {
    const { serverId, templateReadMock } = await setup();
    let limited = false;
    for (let i = 0; i <= USER_PROMPT_RATE_LIMIT_MAX_CALLS; i += 1) {
      const result = (await invoke(CHANNEL, serverId, "file:///x")) as { error?: string };
      if (result.error === "rate-limited") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);

    const result = await invoke(TEMPLATE_CHANNEL, serverId, "file:///project/{path}", {
      path: "a.md",
    });
    expect(result).toMatchObject({ ok: false, error: "rate-limited" });
    expect(templateReadMock).not.toHaveBeenCalled();
  });
});
