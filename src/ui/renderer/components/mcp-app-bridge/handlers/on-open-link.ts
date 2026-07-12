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
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The `onopenlink` request callback shape, derived from the installed `AppBridge`. */
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
