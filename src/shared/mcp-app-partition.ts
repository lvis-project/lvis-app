/**
 * MCP-app identity rules — shared between main and renderer (#885 axis b).
 *
 * Partition naming is the original concern and most of this file; it also holds the two
 * other things the READ PATH must agree on: what a server id may be
 * ({@link isUsableMcpServerId}) and what a card URI may be ({@link isMcpAppUiUri}).
 * Deliberately not every surface — `window-manager`'s detach check and the renderer's
 * bridge handler each keep their own weaker literal, for reasons recorded at those
 * sites.
 *
 * Every MCP server's UI card (`ui://` resource) runs in a dedicated,
 * per-server Electron session partition for storage isolation. Main registers
 * the partition policy (declared-origin network gate + sandbox-proxy protocol
 * handler + relay preload) via `installMcpAppPartitionPolicy`, and the renderer
 * sets the `partition=` attribute on the `<webview>`. Both sides
 * MUST agree on the mapping — drift would route a webview to a partition the
 * main process never policy-registered.
 *
 * Pure module (no DOM / Electron deps) so it imports equally from main,
 * renderer, and worker contexts.
 *
 * ─── Why an INJECTIVE hex encode, not the plugin FNV hash nor the fs-sanitizer ──
 * b's entire purpose is per-server isolation, so serverId → partition MUST be
 * injective: two distinct servers must never share a storage jar. Unlike
 * `pluginId` (admin-issued, non-user-controllable — see `plugin-partition.ts`),
 * the MCP `serverId` is USER-controlled (added via `mcpManager.addConfig` from
 * the renderer / Claude-Desktop import), so a collision-possible hash would let
 * one user-named server read another's storage. The `mcp-manager` filesystem
 * sanitizer (`replace(/[^A-Za-z0-9._-]/g,"_")`) is LOSSY (`a/b` and `a_b` both →
 * `a_b`) so it is unusable as an isolation key either.
 *
 * Hex encoding of the UTF-8 bytes is trivially injective (distinct byte
 * sequences ⇒ distinct hex), and its `[0-9a-f]` output charset is safe for the
 * partition string, the HTML `partition=` attribute value, the detach viewKey,
 * the `ALLOWED_VIEW_KEYS` regex, and the `#detached/` URL fragment
 * simultaneously.
 */

import {
  hasUnsafeUriChars,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "./mcp-resource-bounds.js";

export const MCP_APP_PARTITION_PREFIX = "lvis-mcp-app:";

/**
 * Privileged URL scheme for the host-owned sandbox-proxy document
 * (`lvis-mcp-app://<hex(serverId)>/proxy.html?t=<token>`). Lives here — the pure,
 * DOM/Electron-free partition module — so both `main/mcp-app-protocol.ts` (which
 * registers + serves it) and `main/webview-navigation-policy.ts` (a pure policy
 * module that must allow it) share one SOT without either pulling in the other's
 * Electron/crypto deps. NB: the string equals `MCP_APP_PARTITION_PREFIX` minus its
 * trailing colon — same token, two different layers (URL scheme vs partition name).
 */
export const MCP_APP_SCHEME = "lvis-mcp-app";

/**
 * Defensive upper bound on the raw serverId length. Enforced at BOTH
 * `mcpManager.addConfig` ingestion AND here, because the `servers.json` /
 * `loadFromConfig` path bypasses `addConfig` entirely (a hand-edited or legacy
 * `.bak` file can carry an unbounded id). Over-length ⇒ fail-closed throw so a
 * card render fails loudly rather than minting a pathological
 * partition/viewKey/fragment. The guard is on `serverId.length` (UTF-16 code
 * units); the hex token is 2 chars per UTF-8 byte, so a bounded input keeps
 * every derived token bounded — up to ~2×(UTF-8 byte count) hex chars (e.g.
 * 128 multibyte CJK chars → ~768 hex), never unbounded.
 */
export const MAX_SERVER_ID_LEN = 128;

/**
 * Shape of an MCP server id, for callers that must validate one before using it as
 * a map key, an audit field, or an interpolated value.
 *
 * Lives beside {@link MAX_SERVER_ID_LEN} because that is where the id's bounds
 * already live. The alternative in use before this — borrowing the `mcp-prompt`
 * staged-origin row's `sourcePattern` — worked, but it tied resource and prompt
 * validation to a pattern that exists for ENVELOPE parsing: tightening it for a
 * provenance reason would have silently moved what a server id may be, on paths the
 * policy explicitly says are not staged origins.
 */
const SERVER_ID_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isUsableMcpServerId(value: unknown): value is string {
  // Length checked against the constant rather than baked into the pattern as
  // `{0,127}`: a second spelling of the bound two lines under the constant that
  // exists to hold it once is how the two drift. Checked BEFORE the pattern, so an
  // unbounded string never reaches the regex at all.
  return typeof value === "string"
    && value.length <= MAX_SERVER_ID_LEN
    && SERVER_ID_CHARS_RE.test(value);
}

/**
 * The ONLY scheme reachable through the MCP-Apps read path, and the one rule that
 * decides it.
 *
 * Before this existed the rule was three separate spellings and a hole. `git grep '"ui://"'
 * at e20fea2a (the merge base) finds `main/window-manager.ts` (a bare `startsWith` on a detach
 * payload), `mcp-governance.ts` (a local const), and the renderer's bridge handler (a local
 * const) — and NOT `McpClient.readResource`, which is the one place that issues the
 * request. A cluster review found the consequence. `resources/read` is ONE wire method
 * serving two host paths with different gates — `readDeclaredResource` (listed-set) and
 * `readResource` (Apps) — so a renderer that named a non-`ui:` URI on the Apps path reached
 * a read that neither gate covered: the listed-set check belongs to the other method, and
 * governance, which sees a method and not a caller, fell through to requiring `resources`,
 * which any resource-publishing server has.
 *
 * Kept case-SENSITIVE and authority-REQUIRING on purpose, and the reason is the exemption
 * rather than any downstream comparison. Governance grants the Apps path WITHOUT the
 * `resources` capability, so this predicate decides what SKIPS a capability check;
 * anything it rejects merely falls back to the ordinary rule, which is the safe direction.
 * The URI is also passed verbatim to the server, so the host has no business normalizing
 * a scheme the server will compare literally.
 */
const MCP_APP_UI_SCHEME = "ui://";



/**
 * Is this a URI the MCP-Apps read path will serve?
 *
 * Fail-closed: a caller that cannot answer yes has no business on this path, and the
 * ordinary declared-resource read (with its listed-set gate) is where it belongs.
 */
export function isMcpAppUiUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;
  if (!value.startsWith(MCP_APP_UI_SCHEME)) return false;
  // An authority must be present, and that question is ASKED rather than enumerated.
  //
  // The first version tested `value[5] === "/"`. A reviewer found `?` and `#` reach the
  // same empty authority; enumerating those, a second reviewer found `:`, `[` and `]`
  // make `new URL()` throw. That is three rounds of the same mistake — the one this
  // module already made with the invisible-character class — so it now asks the parser
  // instead of guessing what the terminators are.
  //
  // This ALIGNS with the plugin arm, which parses the authority the same way
  // (`plugin-ui-resource-provider`) and refuses what it cannot read. That is the honest
  // reason: not "no arm could serve this" — the external arm never parses the URI and a
  // server may well answer `ui://?q=1` — but that the host should not exempt from a
  // capability check a URI whose authority it cannot name.
  //
  // `new URL` is used ONLY to ask that question. The value forwarded to the server stays
  // the caller's original string, so no normalization reaches the wire.
  let authority: string;
  try {
    authority = new URL(value).hostname;
  } catch {
    return false;
  }
  if (authority.length === 0) return false;
  // The SAME character rule a resource URI must pass, asked of the one function that
  // spells it. The first version of this predicate enumerated its own ranges and leaked
  // ten of eleven sampled members — including U+061C, a bidi control the comment above it
  // claimed to cover. Two reviewers found that independently, which is the argument for
  // never spelling this class twice.
  return !hasUnsafeUriChars(value);
}

/**
 * Injective encoding of a serverId to a `[0-9a-f]` token: the lowercase hex of
 * its UTF-8 bytes. Distinct serverIds always yield distinct tokens. Fail-closed
 * on an empty or over-length id (No-Fallback).
 */
export function encodeMcpServerId(serverId: string): string {
  if (typeof serverId !== "string" || serverId.length === 0) {
    throw new Error("[mcp-app-partition] serverId must be a non-empty string");
  }
  if (serverId.length > MAX_SERVER_ID_LEN) {
    throw new Error(
      `[mcp-app-partition] serverId exceeds ${MAX_SERVER_ID_LEN} chars (got ${serverId.length})`,
    );
  }
  const bytes = new TextEncoder().encode(serverId);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Per-server ephemeral session partition (no `persist:` ⇒ in-memory). */
export function mcpAppPartitionName(serverId: string): string {
  return `${MCP_APP_PARTITION_PREFIX}${encodeMcpServerId(serverId)}`;
}

/** Detached-window viewKey for one card of a server. `cardId` is host-minted. */
export function mcpAppViewKey(serverId: string, cardId: string): string {
  return `mcp-app:${encodeMcpServerId(serverId)}:${cardId}`;
}

/** Prefix matching every detached viewKey of a server (b3 scoped-close). */
export function mcpAppViewKeyPrefix(serverId: string): string {
  return `mcp-app:${encodeMcpServerId(serverId)}:`;
}
