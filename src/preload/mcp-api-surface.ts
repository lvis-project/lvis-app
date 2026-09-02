/**
 * The `mcp` half of the internal renderer API.
 *
 * Split out of {@link internal-api-surface.ts} for size, not for a change in posture:
 * this object is spliced into that one surface verbatim, and the preload shape lock
 * proves the exposed world is identical either way. Everything here is a passthrough —
 * every gate that matters lives in main, and the bindings a card must not choose
 * (`serverId`, `sessionId`, `cardId`) are supplied by the TRUSTED renderer at each call
 * site rather than by the app.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { McpServerConfig } from "../mcp/types.js";
// Type-only: the renderer declares what each call resolves to; the IPC bridge
// returns `unknown`, and naming the renderer's type here is what keeps the two
// from drifting (the parent surface is checked with `satisfies LvisApi`).
import type { LvisMcpApi } from "../ui/renderer/types.js";

export const mcpApiSurface = {
  servers: async () => ipcRenderer.invoke(CHANNELS.mcp.servers),
  kill: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.kill, id),
  getConfigs: async () => ipcRenderer.invoke(CHANNELS.mcp.configGet),
  getConfigPath: async () => ipcRenderer.invoke(CHANNELS.mcp.configPath),
  addConfig: async (config: McpServerConfig) => ipcRenderer.invoke(CHANNELS.mcp.configAdd, config),
  setApiKey: async (id: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.mcp.configSetApiKey, id, apiKey),
  removeConfig: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.configRemove, id),
  readUiResource: async (serverId: string, uri: string, generationId?: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiResource, serverId, uri, generationId) as ReturnType<NonNullable<LvisMcpApi["readUiResource"]>>,
  // MCP Apps `oncalltool` — the app calls a tool on ITS OWN server. `serverId` is
  // supplied by the TRUSTED renderer from the card's payload (the app has no
  // channel to name a server), and main re-checks that the tool is actually owned
  // by it. Never resolves to a thrown error: main returns an outcome the bridge
  // handler turns into an MCP-style `CallToolResult`.
  callTool: async (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    generationId?: string,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.mcp.callTool,
      serverId,
      name,
      args,
      generationId,
    ) as ReturnType<NonNullable<LvisMcpApi["callTool"]>>,
  // MCP Apps `onmessage` — the app asks for its text to enter the conversation (or the
  // notification surface). BOTH bindings come from the TRUSTED renderer: `serverId`
  // (the card's server) and `sessionId` (the chat session the card belongs to). The
  // app supplies neither, so it can neither impersonate another server nor address a
  // conversation the user has navigated away from — main re-checks the session against
  // the live loop and falls back to a notification on mismatch.
  postUiMessage: async (serverId: string, sessionId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiMessage, serverId, sessionId, params) as ReturnType<NonNullable<LvisMcpApi["postUiMessage"]>>,
  // MCP server prompt (`prompts/get`) — the user picked a prompt from the picker.
  // Returns the server's messages ALREADY wrapped in their provenance envelope;
  // the renderer hands that envelope to `chat.send` under `mcp-prompt-emitted`,
  // and the send gate re-checks the envelope there. Nothing here starts a turn,
  // and the renderer never assembles the envelope itself.
  getPrompt: async (serverId: string, name: string, args: Record<string, string>) =>
    ipcRenderer.invoke(CHANNELS.mcp.getPrompt, serverId, name, args) as ReturnType<NonNullable<LvisMcpApi["getPrompt"]>>,
  attachResource: async (serverId: string, uri: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.attachResource, serverId, uri) as ReturnType<NonNullable<LvisMcpApi["attachResource"]>>,
  listResources: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResources) as ReturnType<NonNullable<LvisMcpApi["listResources"]>>,
  listResourceTemplates: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResourceTemplates) as ReturnType<NonNullable<LvisMcpApi["listResourceTemplates"]>>,
  // The template read. The renderer passes the TEMPLATE and the values the user typed
  // into the host's own dialog — never a URI. Main matches the template against what
  // the client listed and builds the URI there, so nothing the renderer holds can name
  // a resource the server did not publish.
  attachResourceTemplate: async (
    serverId: string,
    uriTemplate: string,
    values: Record<string, string>,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.mcp.attachResourceTemplate,
      serverId,
      uriTemplate,
      values,
    ) as ReturnType<NonNullable<LvisMcpApi["attachResourceTemplate"]>>,
  // MCP Apps `ondownloadfile` — the app hands over inline bytes; main decodes, bounds,
  // and shows a save dialog. `serverId` is bound by the TRUSTED renderer (for the audit
  // trail; the app names no server). Main NEVER fetches an app-supplied URI, so nothing
  // here can be turned into an egress channel. A user cancel comes back as a non-error
  // outcome — declining to save is not a failure.
  downloadFile: async (serverId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiDownloadFile, serverId, params) as ReturnType<NonNullable<LvisMcpApi["downloadFile"]>>,
  // MCP Apps `onupdatemodelcontext` — the app OVERWRITES its slot in the context the
  // model will see on the NEXT turn. THREE bindings come from the TRUSTED renderer:
  // `serverId` (the card's server), `sessionId` (the conversation it belongs to) and
  // `cardId` (this card instance). The app supplies none, so it can neither overwrite
  // another card's slot nor place context into a conversation the user has left. It
  // never starts a turn.
  postUiModelContext: async (serverId: string, sessionId: string, cardId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiModelContext, serverId, sessionId, cardId, params) as ReturnType<NonNullable<LvisMcpApi["postUiModelContext"]>>,
  // Card unmount → free its sandbox-proxy session token (fire-and-forget).
  disposeUiSession: (token: string) => { void ipcRenderer.invoke(CHANNELS.mcp.disposeUiSession, token); },
  // #885 b3 — subscribe to the main→renderer server-disconnected broadcast.
  // Pure event (no gesture / sender validation); McpAppView validates the
  // payload shape and matches on its own serverId. Returns an unsubscribe fn.
  onServerDisconnected: (handler: (serverId: string) => void) => {
    const listener = (_event: unknown, payload: { serverId?: unknown }) => {
      if (typeof payload?.serverId === "string") handler(payload.serverId);
    };
    ipcRenderer.on(CHANNELS.mcp.serverDisconnected, listener);
    return () => ipcRenderer.removeListener(CHANNELS.mcp.serverDisconnected, listener);
  },
} as const;
