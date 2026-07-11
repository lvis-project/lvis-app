/**
 * `WebviewIpcTransport` — the MCP SDK `Transport` for an Electron <webview>.
 *
 * `AppBridge.connect(transport)` accepts ANY SDK `Transport`, so the host side
 * does NOT have to use ext-apps' `PostMessageTransport` (which assumes a plain
 * iframe and validates `event.source === iframe.contentWindow` — neither of which
 * a <webview> can offer: a webview guest is a separate WebContents with no usable
 * `contentWindow` from the embedder).
 *
 * Instead we carry the same JSON-RPC frames over the webview's ipc channel:
 *
 *   host → guest : webview.send(MCP_APP_BRIDGE_CHANNEL, frame)
 *   guest → host : ipcRenderer.sendToHost(...)  ⇒  'ipc-message' event
 *
 * The far end is the host-owned relay preload (`mcp-app-preload.ts`), which
 * forwards frames to/from the inner sandboxed app iframe. The APP still speaks
 * plain `postMessage` to `window.parent` exactly as ext-apps ships it — this
 * transport only replaces the HOST leg, which is the leg Electron makes special.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MCP_APP_BRIDGE_CHANNEL } from "../../../shared/mcp-app-bridge-contract.js";

/** The slice of Electron's `<webview>` element this transport needs. */
export type BridgeWebviewElement = {
  send(channel: string, ...args: unknown[]): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

type IpcMessageEvent = Event & { channel?: string; args?: unknown[] };

export class WebviewIpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  #webview: BridgeWebviewElement;
  #started = false;
  #closed = false;

  /**
   * Frames the guest emitted before `start()` installed the listener. The relay
   * preload announces `sandbox-proxy-ready` as soon as the proxy document loads,
   * which can beat `AppBridge.connect()`; dropping it would deadlock the
   * handshake (the host would never send the HTML). So we listen from
   * construction and replay on start.
   */
  #pending: JSONRPCMessage[] = [];

  #onIpcMessage = (event: Event): void => {
    const ipc = event as IpcMessageEvent;
    if (ipc.channel !== MCP_APP_BRIDGE_CHANNEL) return;
    const frame = ipc.args?.[0] as JSONRPCMessage | undefined;
    if (!frame || typeof frame !== "object") return;
    if (!this.#started) {
      this.#pending.push(frame);
      return;
    }
    this.onmessage?.(frame);
  };

  constructor(webview: BridgeWebviewElement) {
    this.#webview = webview;
    this.#webview.addEventListener("ipc-message", this.#onIpcMessage);
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("[mcp-app] transport already closed");
    this.#started = true;
    const queued = this.#pending;
    this.#pending = [];
    for (const frame of queued) this.onmessage?.(frame);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) return;
    try {
      this.#webview.send(MCP_APP_BRIDGE_CHANNEL, message);
    } catch (err) {
      // The guest can vanish mid-flight (server disconnect, card unmount).
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#pending = [];
    this.#webview.removeEventListener("ipc-message", this.#onIpcMessage);
    this.onclose?.();
  }
}
