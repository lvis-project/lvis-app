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
import type { McpServerConfig, McpUiPayload } from "../mcp/types.js";
import type { McpAppDetachedPayload } from "../shared/mcp-app-detached-payload.js";

export const mcpApiSurface = {
  servers: async () => ipcRenderer.invoke(CHANNELS.mcp.servers),
  kill: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.kill, id),
  getConfigs: async () => ipcRenderer.invoke(CHANNELS.mcp.configGet),
  getConfigPath: async () => ipcRenderer.invoke(CHANNELS.mcp.configPath),
  addConfig: async (config: McpServerConfig) => ipcRenderer.invoke(CHANNELS.mcp.configAdd, config),
  setApiKey: async (id: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.mcp.configSetApiKey, id, apiKey),
  removeConfig: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.configRemove, id),
  readUiResource: async (serverId: string, uri: string, generationId?: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiResource, serverId, uri, generationId) as Promise<unknown>,
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
    ) as Promise<unknown>,
  // MCP Apps `onmessage` — the app asks for its text to enter the conversation (or the
  // notification surface). BOTH bindings come from the TRUSTED renderer: `serverId`
  // (the card's server) and `sessionId` (the chat session the card belongs to). The
  // app supplies neither, so it can neither impersonate another server nor address a
  // conversation the user has navigated away from — main re-checks the session against
  // the live loop and falls back to a notification on mismatch.
  postUiMessage: async (serverId: string, sessionId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiMessage, serverId, sessionId, params) as Promise<unknown>,
  // MCP server prompt (`prompts/get`) — the user picked a prompt from the picker.
  // Returns the server's messages ALREADY wrapped in their provenance envelope;
  // the renderer hands that envelope to `chat.send` under `mcp-prompt-emitted`,
  // and the send gate re-checks the envelope there. Nothing here starts a turn,
  // and the renderer never assembles the envelope itself.
  getPrompt: async (serverId: string, name: string, args: Record<string, string>) =>
    ipcRenderer.invoke(CHANNELS.mcp.getPrompt, serverId, name, args) as Promise<unknown>,
  attachResource: async (serverId: string, uri: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.attachResource, serverId, uri) as Promise<unknown>,
  listResources: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResources) as Promise<unknown>,
  listResourceTemplates: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResourceTemplates) as Promise<unknown>,
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
    ) as Promise<unknown>,
  // MCP Apps `ondownloadfile` — the app hands over inline bytes; main decodes, bounds,
  // and shows a save dialog. `serverId` is bound by the TRUSTED renderer (for the audit
  // trail; the app names no server). Main NEVER fetches an app-supplied URI, so nothing
  // here can be turned into an egress channel. A user cancel comes back as a non-error
  // outcome — declining to save is not a failure.
  downloadFile: async (serverId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiDownloadFile, serverId, params) as Promise<unknown>,
  // MCP Apps `onupdatemodelcontext` — the app OVERWRITES its slot in the context the
  // model will see on the NEXT turn. THREE bindings come from the TRUSTED renderer:
  // `serverId` (the card's server), `sessionId` (the conversation it belongs to) and
  // `cardId` (this card instance). The app supplies none, so it can neither overwrite
  // another card's slot nor place context into a conversation the user has left. It
  // never starts a turn.
  postUiModelContext: async (serverId: string, sessionId: string, cardId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiModelContext, serverId, sessionId, cardId, params) as Promise<unknown>,
  // Card unmount → free its sandbox-proxy session token (fire-and-forget).
  disposeUiSession: (token: string) => { void ipcRenderer.invoke(CHANNELS.mcp.disposeUiSession, token); },
  // #885 b2 — open an MCP-app card in a detached window (host mints the
  // cardId + viewKey; renderer only supplies the payload it already holds).
  // `maximize` is the `onrequestdisplaymode` "fullscreen" arm riding the SAME seam:
  // the detached shell IS the host's fullscreen presentation, so the mode change is
  // a flag on the existing detach, not a new window path.
  // `sessionId` is the card's ORIGIN chat session, bound by the TRUSTED renderer (the
  // app names none). It is what keeps a DETACHED card's `ui/message` /
  // `ui/update-model-context` bound to a real conversation — the detached window has no
  // ChatContext to recover it from. Main sanitizes it and re-checks it against the live
  // session on every use, so it binds and never authorizes.
  // The returned `viewKey` is the host-minted identity of the detached instance: the
  // inline card that just moved there keeps it to recognize its own `onDetachedClosed`.
  openDetached: async (payload: McpUiPayload, opts?: { maximize?: boolean; sessionId?: string }) =>
    ipcRenderer.invoke(CHANNELS.mcp.openDetached, {
      payload,
      maximize: opts?.maximize === true,
      sessionId: typeof opts?.sessionId === "string" ? opts.sessionId : "",
    }) as Promise<{ ok: true; windowId: number; viewKey: string } | { ok: false; error: string }>,
  // The `onrequestdisplaymode` "inline" arm — close THIS server's detached MCP-app
  // window(s). Scoped on purpose: `window.closeAllDetached` sweeps every detached window
  // the user has open, which an untrusted card must never be able to trigger.
  closeDetached: async (serverId: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.closeDetached, serverId) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  // #885 b2 — the detached host renderer fetches its stored record on mount: the card's
  // payload PLUS the origin session the host stamped at detach time.
  getDetachedPayload: async (viewKey: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.detachedPayload, viewKey) as Promise<McpAppDetachedPayload | null>,
  // main→renderer: a detached MCP-app window is gone (closed by the user, closed by the
  // "inline" arm, or navigated away from in the single-instance shell). The inline card
  // that moved there is dormant until this fires — one live bridge per card, always.
  // Pure event (no gesture / sender validation); the renderer validates the payload shape
  // and matches on the viewKey the host handed it at detach time. Returns an unsubscribe fn.
  onDetachedClosed: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: unknown }) => {
      if (typeof payload?.viewKey === "string") handler(payload.viewKey);
    };
    ipcRenderer.on(CHANNELS.mcp.detachedClosed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.mcp.detachedClosed, listener);
  },
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
