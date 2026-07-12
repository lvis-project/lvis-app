/**
 * `onsandboxready` handler — the sandbox handshake leg of the MCP App bridge.
 *
 * The proxy announces it is ready for HTML; we answer with the app document. The
 * relay preload mounts it into the inner sandboxed iframe, after which the App
 * performs `ui/initialize` over the same transport. Extracted from
 * `createMcpAppBridge` into its own React-free, independently unit-testable module.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * The `onsandboxready` notification callback shape, derived from the installed
 * `AppBridge` so it tracks upstream. We import the callback type off the class
 * rather than the named `McpUiSandboxProxyReadyNotification` type because ext-apps
 * 1.7.4's `.d.ts` re-exports its param/result types through extensionless relative
 * imports that do not resolve under `moduleResolution: NodeNext` — a direct named
 * import collapses (TS2460), while an indexed access off the resolvable class value
 * does not. (Same NodeNext hazard that forces the singular setter over
 * `addEventListener`; reverts once modelcontextprotocol/ext-apps#705 lands.)
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
