/**
 * Production host-side wiring for one MCP App card: `AppBridge` + transport.
 *
 * Extracted from `McpAppView.tsx` on purpose. This is the code that actually decides
 * whether an MCP App works — the constructor argument order, the sandbox handshake,
 * the `resources/read` proxy, the `connect()` call — and the real-<webview> e2e gate
 * (`test/e2e/ui/mcp-app-handshake/`) imports THIS module so it exercises the shipping
 * wiring rather than a look-alike reimplementation.
 *
 * That distinction is not academic. The gate previously stood up its own AppBridge, so
 * it proved the architecture end-to-end while proving nothing about how the renderer
 * wired it: drop the `onsandboxready` assignment or swap two constructor args and the
 * product would be dead with the gate still green. Keeping this in a React-free module
 * (no react / lucide / i18n imports) is what lets the e2e page bundle import the real
 * thing.
 *
 * The individual handler BODIES live one-per-file under `mcp-app-bridge/handlers/`;
 * this module is the single wiring surface that computes host capabilities from the
 * active handler set and registers every handler before `connect()`.
 */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
// `McpUiHostContext` comes from the local standard-type twin, not the package —
// a drift-safety/hygiene choice for types, not a strict compile necessity (see
// mcp-app-host-context.ts for the full rationale, including the concrete
// extensionless-chain errors this file's `AppBridge` value import interacted with).
import type { McpUiHostContext } from "./mcp-app-host-context.js";
import type { McpUiPayload, McpUiToolCallOutcome } from "../../../mcp/types.js";
import { MCP_APP_HOST_INFO } from "../../../shared/mcp-app-bridge-contract.js";
import { WebviewIpcTransport, type BridgeWebviewElement } from "./webview-ipc-transport.js";
import { createOnSandboxReady } from "./mcp-app-bridge/handlers/on-sandbox-ready.js";
import { createOnReadResource } from "./mcp-app-bridge/handlers/on-read-resource.js";
import { createOnOpenLink } from "./mcp-app-bridge/handlers/on-open-link.js";
import { createOnSizeChange } from "./mcp-app-bridge/handlers/on-size-change.js";
import { createOnCallTool } from "./mcp-app-bridge/handlers/on-call-tool.js";
import { createOnMessage } from "./mcp-app-bridge/handlers/on-message.js";
import { createOnRequestDisplayMode } from "./mcp-app-bridge/handlers/on-request-display-mode.js";
import { createOnDownloadFile } from "./mcp-app-bridge/handlers/on-download-file.js";
import { createOnUpdateModelContext } from "./mcp-app-bridge/handlers/on-update-model-context.js";
import type { McpUiMessageOutcome } from "../../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../../mcp/mcp-app-model-context.js";
import type { McpUiDisplayMode } from "../../../shared/mcp-app-display-mode.js";

/**
 * The exact `McpUiHostCapabilities` shape the `AppBridge` ctor's 3rd arg expects,
 * derived off the resolvable class value. (A direct named import of
 * `McpUiHostCapabilities` collapses under NodeNext — see the handler modules.)
 */
type McpAppHostCapabilities = ConstructorParameters<typeof AppBridge>[2];

/**
 * React-owned adapters injected by McpAppView. This module stays React-free (the e2e
 * gate imports it), so any handler that needs renderer state or a preload surface
 * receives it here rather than reaching for React/globals.
 */
export interface McpAppBridgeDeps {
  /**
   * `onsizechange` sink — the app reported a content-driven size; McpAppView owns
   * the live card dimensions (React state) and clamps them.
   */
  onResize(next: { width?: number; height?: number }): void;
  /**
   * `onopenlink` opener — routes an external URL through the host's existing
   * effect-gated egress path (`window.lvisApi.openExternalUrl`). Resolves
   * `{ ok: true }` when opened, `{ ok: false }` when the host declined.
   */
  openLink(url: string): Promise<{ ok: boolean }>;
  /**
   * `oncalltool` invoker — runs a tool on the card's OWN server through the host's
   * gated `CHANNELS.mcp.callTool` IPC (risk classification → reviewer/approval →
   * audit). McpAppView binds it to `payload.serverId`: the SERVER BINDING is
   * structural, so the app supplies only a tool name + arguments and can never
   * address another server. Resolves to an outcome — `{ ok: false }` is a host
   * denial or a tool error, which the handler renders as an MCP error result.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpUiToolCallOutcome>;
  /**
   * `onmessage` sink — the app asked for its `ui/message` to reach the user. Routed
   * through the host's gated `CHANNELS.mcp.uiMessage` IPC. McpAppView binds it to the
   * card's `serverId` AND the card's origin session id: BOTH bindings are structural,
   * so the app can address neither another server nor another conversation. Main owns
   * the turn policy (notification / round-boundary guidance / user-gated card) and
   * answers with an outcome only — never conversation content.
   */
  postMessage(params: unknown): Promise<McpUiMessageOutcome>;
  /**
   * `onrequestdisplaymode` reader — the card's CURRENT mode. McpAppView owns the
   * state; the handler answers with this whenever it did not (or could not) move the
   * card, which is the spec's contract for an unavailable mode.
   */
  getDisplayMode(): McpUiDisplayMode;
  /**
   * `onrequestdisplaymode` applier — move the card to a SUPPORTED mode (the handler
   * never calls this for one the host does not advertise) and resolve to the mode
   * actually applied. McpAppView maps it onto the host's EXISTING window seams:
   * `inline` is the in-transcript <webview>, `fullscreen` is the maximized detached
   * shell (`CHANNELS.mcp.openDetached`). No new window stack.
   */
  applyDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
  /**
   * `ondownloadfile` sink — the app asked the host to save inline bytes it already
   * possessed. Routed through the host's gated `CHANNELS.mcp.uiDownloadFile` IPC, which
   * McpAppView binds to the card's `serverId`. Main decodes + bounds the payload, REJECTS
   * any `resource_link` (the host never fetches an app-supplied URI), and puts the user's
   * own save dialog in front of the write. A cancel resolves `{ ok: true }` — declining
   * to save is not an error.
   */
  downloadFile(params: unknown): Promise<McpUiDownloadOutcome>;
  /**
   * `onupdatemodelcontext` sink — the app OVERWROTE the context it wants the model to
   * have NEXT turn. Routed through the host's gated `CHANNELS.mcp.uiModelContext` IPC,
   * which McpAppView binds to the card's `serverId`, its origin session, and its card id.
   * Main stores it as untrusted DATA in that card's one slot; the slot is read at the
   * next prompt build, so this can never start a turn.
   */
  updateModelContext(params: unknown): Promise<McpUiModelContextOutcome>;
}

/**
 * Wire an `AppBridge` to a freshly mounted <webview> for one card.
 *
 * `_client` is `null` and is the FIRST ctor arg: we do not hand ext-apps an MCP
 * `Client` — the real client lives in the main process — so handlers are registered
 * manually and proxied over our existing IPC. `Client` is deliberately never imported
 * as a value; that would drag `sdk/client/index.js` (and with it eventsource/express/
 * hono) into the renderer bundle.
 *
 * Upstream hosts assign these callbacks via `addEventListener("<event>", …)`, but
 * that member is inherited from `ProtocolWithEvents`, whose ext-apps 1.7.4 `.d.ts`
 * uses EXTENSIONLESS relative imports (`from "./events"`) that do not resolve under
 * `moduleResolution: NodeNext` — so the base class, and every member it brings, is
 * invisible to TypeScript here (`skipLibCheck` merely hides the .d.ts error). Members
 * declared directly on `AppBridge` resolve fine, so every handler below uses the
 * singular setter: marked @deprecated but a supported API with identical single-
 * listener semantics, and the runtime JS is unaffected. Reverts to `addEventListener`
 * once modelcontextprotocol/ext-apps#705 lands. NOT worth forking.
 */
export function createMcpAppBridge(
  payload: Pick<McpUiPayload, "serverId">,
  html: string,
  el: BridgeWebviewElement,
  hostContext: McpUiHostContext,
  deps: McpAppBridgeDeps,
): { bridge: AppBridge; transport: WebviewIpcTransport; connected: Promise<void> } {
  const transport = new WebviewIpcTransport(el);

  // ── The active app→host handler set: the single source of truth ─────────────
  // Each entry BOTH (a) contributes the host capability its handler needs advertised
  // and (b) registers that handler on the constructed bridge. The ctor's
  // `McpUiHostCapabilities` is derived from the SAME list that drives registration,
  // by design: advertising a capability whose handler isn't wired (or wiring a
  // handler we never advertised) is a latent, silent bug. Add a handler here and both
  // the capabilities and the wiring move in lockstep — as `oncalltool` did: ONE entry
  // (`{ capability: { serverTools: {} }, register: … }`) and nothing else in here.
  //
  // `register` takes the constructed `bridge` because `onsandboxready` must answer on
  // it; registration therefore runs AFTER construction, still before `connect()`.
  const handlers: Array<{
    capability?: McpAppHostCapabilities;
    register(bridge: AppBridge): void;
  }> = [
    // Sandbox handshake (internal notification — no advertised capability).
    {
      register: (bridge) => {
        bridge.onsandboxready = createOnSandboxReady({ bridge, html });
      },
    },
    // `resources/read` proxy → advertises `serverResources`.
    {
      capability: { serverResources: {} },
      register: (bridge) => {
        bridge.onreadresource = createOnReadResource({ serverId: payload.serverId });
      },
    },
    // `tools/call` on the card's OWN server → advertises `serverTools`. The handler
    // gets the serverId-BOUND invoker (McpAppView closed it over `payload.serverId`),
    // so the app names only a tool; main re-verifies the tool is owned by that server
    // and runs it through the host's risk/consent gate.
    {
      capability: { serverTools: {} },
      register: (bridge) => {
        bridge.oncalltool = createOnCallTool({ callTool: deps.callTool });
      },
    },
    // `ui/message` → advertises `message: { text: {} }` (text only: the host takes no
    // other content kind into a turn). The handler gets the serverId- AND session-BOUND
    // poster (McpAppView closed over both), so the app addresses neither a server nor a
    // conversation; main owns the turn policy and answers `{ isError? }` only.
    {
      capability: { message: { text: {} } },
      register: (bridge) => {
        bridge.onmessage = createOnMessage({ postMessage: deps.postMessage });
      },
    },
    // `ui/update-model-context` → advertises `updateModelContext: { text, structuredContent }`
    // — exactly the two modalities main SERIALIZES into the prompt (text blocks, and
    // structured content as fenced JSON). Advertising `image`/`audio`/`resource` here
    // would invite a payload the host silently drops.
    {
      capability: { updateModelContext: { text: {}, structuredContent: {} } },
      register: (bridge) => {
        bridge.onupdatemodelcontext = createOnUpdateModelContext({
          updateModelContext: deps.updateModelContext,
        });
      },
    },
    // `ui/download-file` → advertises `downloadFile`. The handler gets the serverId-BOUND
    // sink; main decodes the INLINE bytes, rejects any `resource_link` (the host does not
    // fetch app-supplied URIs), and the user's save dialog authorizes the write.
    {
      capability: { downloadFile: {} },
      register: (bridge) => {
        bridge.ondownloadfile = createOnDownloadFile({ downloadFile: deps.downloadFile });
      },
    },
    // `ui/open-link` → advertises `openLinks`.
    {
      capability: { openLinks: {} },
      register: (bridge) => {
        bridge.onopenlink = createOnOpenLink({ openLink: deps.openLink });
      },
    },
    // `ui/request-display-mode` → NO `McpUiHostCapabilities` key exists for display
    // mode (checked against ext-apps `spec.types.d.ts`: the interface carries
    // openLinks / downloadFile / serverTools / serverResources / logging / sandbox /
    // updateModelContext / message / sampling — and nothing else). The advertisement
    // for this one is the HOST CONTEXT's `availableDisplayModes`, published by
    // `buildMcpAppHostContext` from the same SoT the handler enforces. So: a
    // capability-less entry, exactly like the two notification handlers.
    {
      register: (bridge) => {
        bridge.onrequestdisplaymode = createOnRequestDisplayMode({
          getMode: deps.getDisplayMode,
          applyMode: deps.applyDisplayMode,
        });
      },
    },
    // `ui/notifications/size-changed` (View → Host notification — no capability).
    {
      register: (bridge) => {
        bridge.onsizechange = createOnSizeChange({ onResize: deps.onResize });
      },
    },
  ];

  const capabilities = handlers.reduce<McpAppHostCapabilities>(
    (acc, handler) => (handler.capability ? { ...acc, ...handler.capability } : acc),
    {},
  );

  const bridge = new AppBridge(
    null,
    MCP_APP_HOST_INFO,
    capabilities,
    // Standard ext-apps 4th-arg options: seed the initial host context (theme /
    // styles / locale / timeZone / platform). Live updates go through
    // `bridge.setHostContext(...)` on the McpAppView side.
    { hostContext },
  );

  // Register EVERY handler before `connect()` — a late assignment would race the
  // guest's first frames (the relay preload announces sandbox-proxy-ready the moment
  // the proxy document loads, which can beat `connect()`).
  for (const handler of handlers) handler.register(bridge);

  return { bridge, transport, connected: bridge.connect(transport) };
}
