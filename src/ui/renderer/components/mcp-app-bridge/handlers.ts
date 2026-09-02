/**
 * App→host handler factories for one MCP App bridge.
 *
 * Every `create*` below returns one `AppBridge` callback, built from an injected
 * deps object so this module stays React-free and each handler is independently
 * unit-testable without a preload global. `createMcpAppBridge`
 * (`../mcp-app-bridge.ts`) is the single wiring surface that registers them and
 * derives the advertised host capabilities from the same handler set.
 *
 * Kept together deliberately: these are the one bridge's callbacks, all trivial
 * injected-deps factories with no import side effect and no per-handler mock
 * isolation — so one file is the honest home for them, not nine.
 *
 * NodeNext note shared by every handler: each callback TYPE is derived off the
 * installed `AppBridge` class value (`NonNullable<AppBridge["on…"]>`) rather than a
 * named import of the ext-apps param/result types, because ext-apps 1.7.4's `.d.ts`
 * re-exports those through EXTENSIONLESS relative imports that do not resolve under
 * `moduleResolution: NodeNext` — a direct named import collapses (TS2460), while an
 * indexed access off the resolvable class value does not. Reverts once
 * modelcontextprotocol/ext-apps#705 lands.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiToolCallOutcome } from "../../../../mcp/types.js";
import type { McpUiMessageOutcome } from "../../../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../../../mcp/mcp-app-model-context.js";
import {
  isSupportedMcpAppDisplayMode,
  type McpUiDisplayMode,
} from "../../../../shared/mcp-app-display-mode.js";
import { errorMessage } from "../../../../shared/error-message.js";

// ─── onsandboxready ──────────────────────────────────────────────────────────

/**
 * `onsandboxready` handler — the sandbox handshake leg of the MCP App bridge.
 *
 * The proxy announces it is ready for HTML; we answer with the app document. The
 * relay preload mounts it into the inner sandboxed iframe, after which the App
 * performs `ui/initialize` over the same transport.
 */
export type OnSandboxReady = NonNullable<AppBridge["onsandboxready"]>;

export interface OnSandboxReadyDeps {
  /** The constructed bridge — used only to send the app document back. */
  bridge: Pick<AppBridge, "sendSandboxResourceReady">;
  /** The app document HTML to mount into the inner sandboxed iframe. */
  html: string;
}

export function createOnSandboxReady({ bridge, html }: OnSandboxReadyDeps): OnSandboxReady {
  return () => {
    // No `sandbox` field: the relay preload OWNS the inner iframe's sandbox attribute
    // (always `allow-scripts`, opaque origin) and never consumes a wire value — a
    // containment flag must not be renderer-governed. Sending one would be dead data.
    void bridge.sendSandboxResourceReady({ html });
  };
}

// ─── onreadresource ──────────────────────────────────────────────────────────

/**
 * `onreadresource` handler — proxies `resources/read` from the app back to the
 * same main-process chokepoint that gated and fetched this card. The per-server
 * partition policy is already installed, so no new gate is introduced here.
 *
 * ─── `ui://` ONLY (fail closed) ──────────────────────────────────────────────
 * The uri is the ONE thing the app supplies (the serverId is bound at wire time), and
 * it used to travel to the read IPC untouched — an app could ask its server for ANY
 * resource, not just the UI resources this surface exists to serve. Two reasons that
 * is not acceptable even though the read is server-scoped:
 *   · it widens an MCP App's reach from "my own card's HTML" to "anything my server
 *     exposes", which is a data surface the user never consented to when they invoked
 *     a UI tool, and
 *   · every read MINTS a sandbox-proxy session token from a BOUNDED LRU, so an app
 *     looping reads evicts other live cards' tokens (their next reload 404s).
 * So the handler admits `ui://` and refuses everything else, before the IPC. Refusal is
 * a throw: the bridge turns it into a JSON-RPC error the app can actually see, unlike
 * the notification-shaped requests elsewhere in this feature.
 *
 * Reaches `window.lvis.mcp` directly — the renderer global is the existing seam.
 */
export type OnReadResource = NonNullable<AppBridge["onreadresource"]>;

/**
 * The only scheme an MCP App may read through this proxy. It matches the
 * `_meta.ui` contract: a `ui://` resource IS the card surface, and nothing else
 * on the server is reachable from inside the sandbox.
 */
const MCP_UI_URI_PREFIX = "ui://";

export interface OnReadResourceDeps {
  /** The MCP server whose partition + policy already gated this card. */
  serverId: string;
}

export function createOnReadResource({ serverId }: OnReadResourceDeps): OnReadResource {
  return async ({ uri }) => {
    if (typeof uri !== "string" || !uri.startsWith(MCP_UI_URI_PREFIX)) {
      throw new Error("resources/read is restricted to ui:// resources");
    }
    const bundle = await window.lvis.mcp.readUiResource(serverId, uri);
    return {
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: bundle.html }],
    };
  };
}

// ─── onopenlink ──────────────────────────────────────────────────────────────

/**
 * `onopenlink` handler — the app asked to open an external URL (`ui/open-link`).
 *
 * We do NOT build a new IPC/preload surface or a new gate: this reuses the host's
 * existing effect-gated egress path (`window.lvisApi.openExternalUrl` →
 * `CHANNELS.shell.openExternal`), which main scheme-validates (rejects
 * `file:`/`javascript:`) and which the effect ledger already treats as a gated
 * write. The opener is injected via deps so this module stays React-free and
 * unit-testable without a preload global.
 */
export type OnOpenLink = NonNullable<AppBridge["onopenlink"]>;

export interface OnOpenLinkDeps {
  /**
   * Open an external URL through the host's existing gated egress path. Resolves
   * `{ ok: true }` when main accepted + opened the URL, `{ ok: false }` when it was
   * rejected (bad scheme, malformed URL, or a denied effect).
   */
  openLink(url: string): Promise<{ ok: boolean }>;
}

export function createOnOpenLink({ openLink }: OnOpenLinkDeps): OnOpenLink {
  return async ({ url }) => {
    const result = await openLink(url);
    // Spec `McpUiOpenLinkResult`: `{}` = opened, `{ isError: true }` = host declined.
    return result?.ok ? {} : { isError: true };
  };
}

// ─── onsizechange ────────────────────────────────────────────────────────────

/**
 * `onsizechange` handler — the app measured its content (typically via a
 * `ResizeObserver`) and sent `ui/notifications/size-changed` (View → Host). Mirror
 * basic-host: forward the reported width/height to the host.
 *
 * The numbers are UNTRUSTED and are NOT bounded here. They are bounded at the sink,
 * where they become pixels: McpAppView's `onResize` runs them through
 * `clampMcpAppCardSize` (shared/mcp-app-card-size.ts), which rejects non-finite / ≤ 0
 * values and clamps the rest into `MCP_APP_CARD_{MIN,MAX}_{WIDTH,HEIGHT}_PX`. One
 * bound, at one sink — this stays a pure forward.
 */
export type OnSizeChange = NonNullable<AppBridge["onsizechange"]>;

export interface OnSizeChangeDeps {
  /**
   * Apply a content-driven size change to the card. The sink is where the bound lives:
   * it clamps the reported numbers into the card-size SoT before they reach layout.
   */
  onResize(next: { width?: number; height?: number }): void;
}

export function createOnSizeChange({ onResize }: OnSizeChangeDeps): OnSizeChange {
  return ({ width, height }) => {
    onResize({ width, height });
  };
}

// ─── oncalltool ──────────────────────────────────────────────────────────────

/**
 * `oncalltool` handler — the app asked to call a tool on ITS OWN MCP server
 * (`tools/call`). The security-critical one.
 *
 * This module does NOT decide anything. It proxies the request to the host's gated
 * `CHANNELS.mcp.callTool` IPC (via the injected `callTool`, which McpAppView binds
 * to the CARD's `payload.serverId`) and shapes the answer back into the spec's
 * `CallToolResult`. Two consequences worth naming:
 *
 *  - The app NEVER names a server. `tools/call` params carry only `name` +
 *    `arguments`; the server binding is supplied by the trusted renderer and
 *    re-verified in main (tool-owner == serverId). There is no channel here through
 *    which a compromised app could reach another server's tools.
 *  - Denials and failures come back as an MCP-style ERROR RESULT
 *    (`{ isError: true, content: [...] }`), not a thrown/rejected bridge request:
 *    the app sees a normal tool result it can render, and a host denial is not
 *    reported to it as a protocol fault. The host's risk/consent gate (which may
 *    ask the user) runs in main — this handler just awaits its outcome.
 */
export type OnCallTool = NonNullable<AppBridge["oncalltool"]>;

/** The `CallToolResult` this handler returns (spec shape, derived off the bridge). */
type CallToolResult = Awaited<ReturnType<OnCallTool>>;

export interface OnCallToolDeps {
  /**
   * Run a tool on the card's OWN server through the host's gated IPC. Already bound
   * to the card's `serverId` by McpAppView — this handler cannot choose a server.
   * Resolves to an outcome; a `{ ok: false }` is a host DENIAL or a tool error.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpUiToolCallOutcome>;
}

/** MCP-style error result — what the app gets for any denial or failure. */
function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Render the host tool layer's raw value as a text content block. The host executor's
 * result contract is a rendered string (external MCP tools) or an arbitrary plugin
 * return value (loopback) — it does not carry MCP content blocks, so we do not
 * fabricate typed blocks the host never produced.
 */
function textBlock(result: unknown): { type: "text"; text: string } {
  if (typeof result === "string") return { type: "text", text: result };
  if (result === undefined || result === null) return { type: "text", text: "" };
  try {
    return { type: "text", text: JSON.stringify(result) ?? String(result) };
  } catch {
    return { type: "text", text: String(result) };
  }
}

export function createOnCallTool({ callTool }: OnCallToolDeps): OnCallTool {
  return async ({ name, arguments: args }) => {
    let outcome: McpUiToolCallOutcome;
    try {
      outcome = await callTool(name, args ?? {});
    } catch (err) {
      // The IPC itself failed (transport / unauthorized frame throw). Still an error
      // RESULT, never a rejected bridge request.
      return errorResult(errorMessage(err));
    }
    if (!outcome.ok) return errorResult(outcome.message ?? outcome.error);
    return { content: [textBlock(outcome.result)] };
  };
}

// ─── onmessage ───────────────────────────────────────────────────────────────

/**
 * `onmessage` handler — the app asked for its message to reach the user (`ui/message`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiMessage` IPC (via the injected `postMessage`, which McpAppView binds
 * to the CARD's `serverId` AND the card's origin session id) and shapes the answer into
 * the spec's `McpUiMessageResult`. Three consequences worth naming:
 *
 *  - The app names neither a server nor a conversation. Both bindings come from the
 *    trusted renderer, so a compromised app can reach neither another server's card nor
 *    a session the user has navigated away from (main re-checks the session against the
 *    live loop and falls back to a notification on mismatch).
 *  - The host's TURN POLICY runs in main, not here: notification meta → the popup
 *    surface; an active turn → round-boundary guidance; no active turn → a user-gated
 *    staging card. The app never learns which happened beyond accept/reject — and it
 *    can never autonomously wake the model.
 *  - The result is `{ isError?: boolean }` and NOTHING else. The type itself forbids
 *    echoing conversation content back to the app, which is the spec's explicit MUST NOT.
 */
export type OnMessage = NonNullable<AppBridge["onmessage"]>;

/** The `McpUiMessageResult` this handler returns (spec shape, derived off the bridge). */
type McpUiMessageResult = Awaited<ReturnType<OnMessage>>;

export interface OnMessageDeps {
  /**
   * Deliver the app's `ui/message` params through the host's gated IPC. Already bound
   * to the card's `serverId` + origin session id by McpAppView — this handler cannot
   * choose either. Resolves to an outcome; `{ ok: false }` is a host rejection.
   */
  postMessage(params: unknown): Promise<McpUiMessageOutcome>;
}

export function createOnMessage({ postMessage }: OnMessageDeps): OnMessage {
  return async (params) => {
    try {
      const outcome = await postMessage(params);
      // Accept → `{}`. Reject → `{ isError: true }`. No content, no reason: the app is
      // told whether the host took it, never what the conversation contains.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiMessageResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT,
      // never a rejected bridge request.
      return { isError: true } satisfies McpUiMessageResult;
    }
  };
}

// ─── onrequestdisplaymode ────────────────────────────────────────────────────

/**
 * `onrequestdisplaymode` handler — the app asked to be presented differently
 * (`ui/request-display-mode`).
 *
 * The default `AppBridge` behaviour is to ECHO the host context's `displayMode` back,
 * which means a host that leaves this unset silently ignores every request while
 * appearing to answer it. Registering the handler is what makes the mode real, and the
 * contract is precise: return the mode ACTUALLY APPLIED, which is the current one when
 * the request cannot be honoured.
 *
 * Exactly one rule lives here, and it lives ONLY here: a requested mode is honoured iff
 * it is in the host's advertised set (`MCP_APP_AVAILABLE_DISPLAY_MODES` — the same SoT
 * McpAppView publishes as the host context's `availableDisplayModes`, so what the app
 * is told it may ask for and what the host will accept can never disagree). Anything
 * else — any mode a future spec adds — resolves to the card's current mode. No throw:
 * an unavailable mode is a normal, expected answer.
 *
 * The APPLY itself is McpAppView's (it owns the card's surface: the in-transcript
 * <webview> and the renderer-side away surfaces). This module never touches a window.
 */
export type OnRequestDisplayMode = NonNullable<AppBridge["onrequestdisplaymode"]>;

export interface OnRequestDisplayModeDeps {
  /** The card's CURRENT display mode, read at call time (McpAppView owns the state). */
  getMode(): McpUiDisplayMode;
  /**
   * Apply a SUPPORTED mode to this card's surface. Resolves to the mode actually
   * applied — which is the previous one when the host declined. Never called for an
   * unsupported mode.
   */
  applyMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
}

export function createOnRequestDisplayMode(
  { getMode, applyMode }: OnRequestDisplayModeDeps,
): OnRequestDisplayMode {
  return async ({ mode }) => {
    // Not advertised ⇒ not applied. Answer with the mode the card is actually in.
    if (!isSupportedMcpAppDisplayMode(mode)) return { mode: getMode() };
    try {
      return { mode: await applyMode(mode) };
    } catch {
      // The apply path failed (IPC transport / unauthorized frame throw). The card did
      // not move, so the truthful answer is the mode it is still in.
      return { mode: getMode() };
    }
  };
}

// ─── ondownloadfile ──────────────────────────────────────────────────────────

/**
 * `ondownloadfile` handler — the app asked the host to save a file (`ui/download-file`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiDownloadFile` IPC (via the injected `downloadFile`, which McpAppView
 * binds to the CARD's `serverId`) and shapes the answer into the spec's
 * `McpUiDownloadFileResult`. Three consequences worth naming:
 *
 *  - It does NOT do what the ext-apps JSDoc example does. That example decodes the blob
 *    IN THE HOST FRAME (`atob` → `Blob` → an `<a download>` click) and answers a
 *    `resource_link` with `window.open(item.uri)`. Both are wrong here: the first would
 *    write a file with no user-visible destination, and the second would let a sandboxed
 *    iframe steer the host's network identity at an arbitrary URI. Decoding, bounding and
 *    saving happen in MAIN, behind a save dialog, and a `resource_link` is rejected at
 *    parse time (see mcp/mcp-app-download.ts).
 *  - A user CANCEL is NOT an error. The host outcome distinguishes "saved" from
 *    "cancelled", and both map to `{}` — raising `isError` for a user who simply
 *    declined would tell the app to retry or report a failure that never happened.
 *  - Every rejection — an unsupported resource link, an over-cap payload, a malformed
 *    block, a denied IPC — comes back as `{ isError: true }` and nothing else. The app is
 *    never told WHY, and never sees a rejected bridge request.
 */
export type OnDownloadFile = NonNullable<AppBridge["ondownloadfile"]>;

/** The `McpUiDownloadFileResult` this handler returns (spec shape, derived off the bridge). */
type McpUiDownloadFileResult = Awaited<ReturnType<OnDownloadFile>>;

export interface OnDownloadFileDeps {
  /**
   * Hand the app's `ui/download-file` params to the host's gated IPC. Already bound to
   * the card's `serverId` by McpAppView — this handler cannot choose a server. Resolves
   * to an outcome; `{ ok: false }` is a host rejection, and a user cancel is `ok: true`.
   */
  downloadFile(params: unknown): Promise<McpUiDownloadOutcome>;
}

export function createOnDownloadFile({ downloadFile }: OnDownloadFileDeps): OnDownloadFile {
  return async (params) => {
    try {
      const outcome = await downloadFile(params);
      // saved → `{}`. cancelled → `{}` (the user declined; nothing failed).
      // rejected → `{ isError: true }`, with no reason attached.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiDownloadFileResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT,
      // never a rejected bridge request.
      return { isError: true } satisfies McpUiDownloadFileResult;
    }
  };
}

// ─── onupdatemodelcontext ────────────────────────────────────────────────────

/**
 * `onupdatemodelcontext` handler — the app OVERWROTE the context it wants the model to
 * have on the next turn (`ui/update-model-context`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiModelContext` IPC (via the injected `updateModelContext`, which
 * McpAppView binds to the CARD's `serverId`, its origin session, and its card id) and
 * answers with an `EmptyResult`. Three consequences worth naming:
 *
 *  - The result is `{}` — ALWAYS. `McpUiUpdateModelContextRequest` has no error channel
 *    (the spec's result type is `EmptyResult`), so a host refusal — an over-cap body, a
 *    stale session — is an AUDIT fact, not a protocol one. We do not invent an `isError`
 *    the spec does not define, and we do not throw: a rejected bridge request would tell
 *    the app to retry a store it is never going to win.
 *  - It NEVER triggers a turn. That is not a rule this module enforces; it is a fact of
 *    the seam. Main writes the card's slot, and the slot is READ at the next prompt
 *    build. There is no push path to the conversation loop from here at all.
 *  - The app names neither a server, a conversation, nor a card. All three bindings come
 *    from the trusted renderer, so a compromised app cannot overwrite another card's
 *    context or speak into a conversation the user has navigated away from.
 */
export type OnUpdateModelContext = NonNullable<AppBridge["onupdatemodelcontext"]>;

/** The `EmptyResult` this handler returns (spec shape, derived off the bridge). */
type EmptyResult = Awaited<ReturnType<OnUpdateModelContext>>;

export interface OnUpdateModelContextDeps {
  /**
   * Hand the app's `ui/update-model-context` params to the host's gated IPC. Already
   * bound to the card's `serverId` + origin session id + card id by McpAppView — this
   * handler cannot choose any of them.
   */
  updateModelContext(params: unknown): Promise<McpUiModelContextOutcome>;
}

export function createOnUpdateModelContext(
  { updateModelContext }: OnUpdateModelContextDeps,
): OnUpdateModelContext {
  return async (params) => {
    try {
      await updateModelContext(params);
    } catch {
      // The IPC itself failed (transport / unauthorized frame throw). Still an empty
      // RESULT, never a rejected bridge request — see the header.
    }
    return {} satisfies EmptyResult;
  };
}
