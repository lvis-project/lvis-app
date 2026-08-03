import { isStagedSendOrigin } from "./staged-origins.js";

export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  /**
   * MCP App (`ui/message`) — an untrusted sandboxed app frame asked for its text
   * to enter the conversation. NEVER `user-keyboard`: the host cannot verify a
   * gesture claim made inside an untrusted iframe, so app text is staged for an
   * explicit user click (no active turn) or injected as round-boundary guidance
   * (active turn), and its tool calls are treated as non-user provenance.
   * Provenance travels in the `<app-message source="app:<serverId>">` envelope —
   * see `shared/mcp-app-message-source.ts`.
   */
  | "app-emitted"
  /**
   * MCP server prompt (`prompts/get`) — the USER explicitly selected a prompt the
   * server declared, but the returned messages are SERVER-authored. Never
   * `user-keyboard`: the user chose to run it, not what it says, so the text is
   * staged with untrusted provenance and its tool calls are non-user provenance.
   * Provenance travels in the `<mcp-prompt source="mcp-prompt:<serverId>">`
   * envelope — see `shared/staged-origins.ts`.
   */
  | "mcp-prompt-emitted"
  | "llm-tool-arg"
  | "agent-message"
  | "file-content"
  /**
   * Text submitted by a host-bound local non-renderer surface (for example the
   * loopback API or a future local CLI). The
   * transport mints this value; request bodies cannot elevate it to
   * `user-keyboard`, so tool trust, memory capture, and request anchors remain
   * non-keyboard by default.
   */
  | "surface-user"
  /**
   * Text from the native Tailnet controller. This is intentionally distinct
   * from local surfaces: its host-owned controller authority survives through
   * the tool boundary, where every authority-bearing action is local one-shot
   * approved and never consumes a remembered grant.
   */
  | "tailnet-surface"
  /**
   * Text admitted from an explicitly paired external chat platform. The
   * provider webhook has already been verified by a host-owned adapter; it
   * still carries a separate remote-controller authority through the tool
   * boundary, so it can never inherit local or Tailnet grants.
   */
  | "platform-bridge"
  | "queue-auto";

/**
 * Non-forgeable authority attached by the conversation command port, never
 * parsed from an external chat payload. The actor id is a host-produced digest
 * rather than a raw Tailnet login.
 */
export interface TailnetPairingShareBinding {
  /** Local durable pairing record id; never a raw Tailnet identity. */
  readonly pairingId: string;
  /** Pairing generation invalidated by local revoke. */
  readonly pairingEpoch: number;
  /** Local durable conversation-share record id. */
  readonly shareId: string;
  /** Share generation invalidated by local revoke or replacement. */
  readonly shareEpoch: number;
  /** Random public scope, never a persisted conversation/session id. */
  readonly scope: string;
}

/**
 * Host-private revocation guard for an already admitted paired controller turn.
 *
 * The capability is only supplied by the main-process pairing store. It is
 * never serialized, exposed to a renderer, or parsed from a remote command.
 * P1 direct Tailnet control has no binding/guard and retains its existing
 * allow-once semantics.
 */
export interface TailnetPairedShareGuard {
  isCurrent(binding: TailnetPairingShareBinding): boolean;
}


export interface TailnetControllerAuthority {
  readonly kind: "tailnet-controller";
  readonly actorId: `tailnet:${string}`;
  /** Present only for the explicit P2 paired-sharing ingress. */
  readonly pairedShare?: TailnetPairingShareBinding;
  /** Host-private final-boundary revocation check for paired shares. */
  readonly pairedShareGuard?: TailnetPairedShareGuard;
}

/** Opaque host record for one paired external platform route. */
export interface PlatformBridgeBinding {
  /** Local durable bridge record id; never a provider account or channel id. */
  readonly bridgeId: string;
  /** Bridge generation invalidated by local revoke. */
  readonly bridgeEpoch: number;
  /** Local durable paired-route record id. */
  readonly routeId: string;
  /** Route generation invalidated by local revoke or replacement. */
  readonly routeEpoch: number;
  /** Random public scope, never a provider conversation or internal session id. */
  readonly scope: string;
}

/** Host-private revocation guard for an admitted external-platform turn. */
export interface PlatformBridgeGuard {
  isCurrent(binding: PlatformBridgeBinding): boolean;
}

/**
 * Host-owned authority carried by a verified, explicitly paired platform
 * webhook. It is intentionally distinct from a Tailnet controller: provider
 * identity, pairing route, and policy do not cross either transport boundary.
 */
export interface PlatformBridgeAuthority {
  readonly kind: "platform-bridge";
  readonly actorId: string;
  readonly bridgeBinding: PlatformBridgeBinding;
  readonly bridgeGuard: PlatformBridgeGuard;
}

/** Common remote-controller policy carrier for Tailnet and future platforms. */
export type RemoteControllerAuthority = TailnetControllerAuthority | PlatformBridgeAuthority;

/**
 * Test a paired controller share at an authority-bearing boundary.
 *
 * Direct P1 Tailnet control deliberately has neither field and preserves its
 * existing local allow-once behavior. A malformed partial P2 authority, a
 * revoked binding, or a guard failure must instead deny: no caller may treat a
 * missing P2 guard as an implied durable share.
 */
function isTailnetPairedShareCurrent(
  authority: TailnetControllerAuthority | undefined,
): boolean {
  const binding = authority?.pairedShare;
  const guard = authority?.pairedShareGuard;
  if (binding === undefined && guard === undefined) return true;
  if (binding === undefined || guard === undefined) return false;
  try {
    return guard.isCurrent(binding) === true;
  } catch {
    return false;
  }

}

/**
 * Recheck an admitted remote authority immediately before an effect boundary.
 * Tailnet P1 direct control has no durable binding and remains valid for its
 * active connection; platform ingress is paired-only and always has a guard.
 */
export function isRemoteControllerAuthorityCurrent(
  authority: RemoteControllerAuthority | undefined,
): boolean {
  if (authority === undefined) return true;
  if (authority.kind === "tailnet-controller") {
    return isTailnetPairedShareCurrent(authority);
  }
  try {
    return authority.bridgeGuard.isCurrent(authority.bridgeBinding) === true;
  } catch {
    return false;
  }
}
/**
 * The origins whose text arrives inside a provenance envelope. Named so the
 * staged-origin registry can be a TOTAL `Record` over them: every lookup by a
 * literal member is then compile-checked and cannot be `undefined`, which removes
 * the defensive `!`/throw at each module-level lookup.
 */
export type StagedChatInputOrigin = Extract<
  ChatInputOrigin,
  "plugin-emitted" | "app-emitted" | "mcp-prompt-emitted"
>;

export type ChatSendInputOrigin =
  | StagedChatInputOrigin
  | Extract<
    ChatInputOrigin,
    "user-keyboard" | "queue-auto" | "surface-user" | "tailnet-surface" | "platform-bridge"
  >;
export type TrustOriginWithUnknown = ChatInputOrigin | "unknown";

export interface ChatSendPayload {
  input: string;
  attachments?: unknown;
  inputOrigin: ChatSendInputOrigin;
  userActivation?: boolean;
  personaPromptId?: string;
}


/**
 * Public payload accepted by non-renderer surfaces. The host, not the caller,
 * adds the actual ChatSendInputOrigin at the conversation command boundary.
 */
export interface ExternalChatSendPayload {
  input: string;
  attachments?: unknown;
}
export interface UserKeyboardIntentSnapshot {
  inputOrigin: "user-keyboard";
  token: string;
}

export interface UserKeyboardIntent {
  inputOrigin: "user-keyboard";
  userActivation: true;
}


/**
 * Turn-entry provenance. Do not pass this through as the tool invocation
 * provenance without reclassifying at the model/tool boundary.
 */
export function isUserKeyboardOrigin(origin: ChatInputOrigin): boolean {
  return origin === "user-keyboard";
}

export function isChatSendInputOrigin(value: unknown): value is ChatSendInputOrigin {
  // The staged half is DERIVED from the staged-origin registry. Listing those
  // literals here by hand is how a registered origin gets silently rejected at
  // the send gate: the type union widens, the runtime guard does not, and tsc
  // sees nothing because the guard is a hand-written predicate.
  return value === "user-keyboard"
    || value === "queue-auto"
    || value === "surface-user"
    || value === "tailnet-surface"
    || value === "platform-bridge"
    || isStagedSendOrigin(value);
}

export function hasUserKeyboardIntent(value: unknown): value is UserKeyboardIntent {
  if (!value || typeof value !== "object") return false;
  const payload = value as { inputOrigin?: unknown; userActivation?: unknown };
  return payload.inputOrigin === "user-keyboard" && payload.userActivation === true;
}
