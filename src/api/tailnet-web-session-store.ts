/**
 * Ephemeral browser-session store for the same-origin Tailnet Web adapter.
 *
 * Cookies and CSRF values are high-entropy one-time browser secrets. Their raw
 * values are returned only while issuing a session and are never persisted:
 * records retain domain-separated digests plus the opaque paired-share
 * authority needed for each request's reauthorization.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import type { TailnetPairingShareBinding } from "../shared/chat-origin.js";
import type { TailnetShareActorId } from "../main/tailnet-pairing-share-store.js";

const SESSION_BYTES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const MAX_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_CSRF_TOKENS_PER_SESSION = 64;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACTOR = /^tailnet:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TailnetWebSessionAuthorization {
  readonly actorId: TailnetShareActorId;
  readonly pairedShare: TailnetPairingShareBinding;
  readonly expiresAt: number;
}

export interface TailnetWebIssuedSession extends TailnetWebSessionAuthorization {
  /** HttpOnly cookie value; never retained in the store. */
  readonly cookieToken: string;
  /** Page-local CSRF value; never retained in the store. */
  readonly csrfToken: string;
}

export interface TailnetWebSessionStore {
  issue(input: Readonly<{
    actorId: TailnetShareActorId;
    pairedShare: TailnetPairingShareBinding;
  }>): TailnetWebIssuedSession | null;
  /**
   * Add an independent page CSRF secret to a current browser session. This
   * keeps separately opened same-origin tabs usable without rotating their
   * shared HttpOnly cookie.
   */
  issuePageCsrf(cookieToken: string, input: Readonly<{
    actorId: TailnetShareActorId;
    pairedShare: TailnetPairingShareBinding;
  }>): TailnetWebIssuedSession | null;
  resolve(cookieToken: string): TailnetWebSessionAuthorization | null;
  resolveMutation(cookieToken: string, csrfToken: string): TailnetWebSessionAuthorization | null;
  revoke(cookieToken: string): void;
  clear(): void;
  /** Subscribe to session invalidation; listeners must treat it as fail-closed. */
  subscribe(listener: () => void): () => void;
}

export interface CreateTailnetWebSessionStoreOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly ttlMs?: number;
  readonly maxSessions?: number;
  readonly maxCsrfTokensPerSession?: number;
}

interface StoredSession extends TailnetWebSessionAuthorization {
  readonly cookieDigest: string;
  readonly csrfDigests: Set<string>;
}

export function createTailnetWebSessionStore(
  options: CreateTailnetWebSessionStoreOptions = {},
): TailnetWebSessionStore {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxCsrfTokensPerSession = options.maxCsrfTokensPerSession
    ?? DEFAULT_MAX_CSRF_TOKENS_PER_SESSION;
  if (
    typeof now !== "function"
    || typeof randomBytes !== "function"
    || !validDuration(ttlMs)
    || !Number.isSafeInteger(maxSessions)
    || maxSessions < 1
    || maxSessions > 256
    || !Number.isSafeInteger(maxCsrfTokensPerSession)
    || maxCsrfTokensPerSession < 1
    || maxCsrfTokensPerSession > 256
  ) {
    throw new Error("tailnet-web-session-store-invalid");
  }

  const records = new Map<string, StoredSession>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A transport subscriber must not break invalidation for the others.
      }
    }
  };


  const checkedNow = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("tailnet-web-session-store-clock-invalid");
    }
    return value;
  };

  const prune = (at: number): void => {
    let changed = false;
    for (const [key, record] of records) {
      if (record.expiresAt <= at) {
        records.delete(key);
        changed = true;
      }
    }
    if (changed) notify();
  };

  const resolve = (cookieToken: string): TailnetWebSessionAuthorization | null => {
    if (!TOKEN.test(cookieToken)) return null;
    const at = checkedNow();
    prune(at);
    const record = records.get(digest("cookie", cookieToken));
    return record === undefined ? null : authorize(record);
  };

  return Object.freeze({
    issue(input: Readonly<{ actorId: TailnetShareActorId; pairedShare: TailnetPairingShareBinding }>): TailnetWebIssuedSession | null {
      if (!validActor(input?.actorId) || !validBinding(input?.pairedShare)) return null;
      const at = checkedNow();
      prune(at);
      if (records.size >= maxSessions) return null;
      const cookieToken = mint(randomBytes);
      const csrfToken = mint(randomBytes);
      const expiresAt = at + ttlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("tailnet-web-session-store-clock-invalid");
      }
      const record: StoredSession = Object.freeze({
        actorId: input.actorId,
        pairedShare: Object.freeze({ ...input.pairedShare }),
        expiresAt,
        cookieDigest: digest("cookie", cookieToken),
        csrfDigests: new Set([digest("csrf", csrfToken)]),
      });
      records.set(record.cookieDigest, record);
      return Object.freeze({
        ...authorize(record),
        cookieToken,
        csrfToken,
      });
    },
    issuePageCsrf(
      cookieToken: string,
      input: Readonly<{ actorId: TailnetShareActorId; pairedShare: TailnetPairingShareBinding }>,
    ): TailnetWebIssuedSession | null {
      if (!TOKEN.test(cookieToken) || !validActor(input?.actorId) || !validBinding(input?.pairedShare)) {
        return null;
      }
      const at = checkedNow();
      prune(at);
      const record = records.get(digest("cookie", cookieToken));
      if (
        record === undefined
        || record.actorId !== input.actorId
        || !sameBinding(record.pairedShare, input.pairedShare)
        || record.csrfDigests.size >= maxCsrfTokensPerSession
      ) {
        return null;
      }
      const csrfToken = mint(randomBytes);
      record.csrfDigests.add(digest("csrf", csrfToken));
      return Object.freeze({
        ...authorize(record),
        cookieToken,
        csrfToken,
      });
    },


    resolve,

    resolveMutation(cookieToken: string, csrfToken: string): TailnetWebSessionAuthorization | null {
      if (!TOKEN.test(csrfToken)) return null;
      const session = resolve(cookieToken);
      if (session === null) return null;
      const record = records.get(digest("cookie", cookieToken));
      if (record === undefined || !hasMatchingCsrfDigest(record.csrfDigests, digest("csrf", csrfToken))) {
        return null;
      }
      return session;
    },

    revoke(cookieToken: string): void {
      if (!TOKEN.test(cookieToken)) return;
      if (records.delete(digest("cookie", cookieToken))) notify();
    },

    clear(): void {
      if (records.size === 0) return;
      records.clear();
      notify();
    },

    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("tailnet-web-session-store-listener-invalid");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function authorize(record: StoredSession): TailnetWebSessionAuthorization {
  return Object.freeze({
    actorId: record.actorId,
    pairedShare: Object.freeze({ ...record.pairedShare }),
    expiresAt: record.expiresAt,
  });
}

function mint(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(SESSION_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_BYTES) {
    throw new Error("tailnet-web-session-store-random-invalid");
  }
  const token = bytes.toString("base64url");
  if (!TOKEN.test(token)) throw new Error("tailnet-web-session-store-random-invalid");
  return token;
}

function digest(domain: "cookie" | "csrf", value: string): string {
  return createHash("sha256")
    .update("lvis/tailnet-web-session/v1\0" + domain + "\0" + value, "utf8")
    .digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function hasMatchingCsrfDigest(digests: ReadonlySet<string>, candidate: string): boolean {
  let matched = false;
  for (const digestValue of digests) {
    matched = sameDigest(digestValue, candidate) || matched;
  }
  return matched;
}

function sameBinding(left: TailnetPairingShareBinding, right: TailnetPairingShareBinding): boolean {
  return left.pairingId === right.pairingId
    && left.pairingEpoch === right.pairingEpoch
    && left.shareId === right.shareId
    && left.shareEpoch === right.shareEpoch
    && left.scope === right.scope;
}


function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TTL_MS;
}

function validActor(value: unknown): value is TailnetShareActorId {
  return typeof value === "string" && ACTOR.test(value);
}

function validBinding(value: unknown): value is TailnetPairingShareBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TailnetPairingShareBinding>;
  return uuid(candidate.pairingId)
    && epoch(candidate.pairingEpoch)
    && uuid(candidate.shareId)
    && epoch(candidate.shareEpoch)
    && uuid(candidate.scope);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
