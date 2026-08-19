/**
 * Durable per-child store for parent directives the child has not read yet.
 *
 * A directive is stored BEFORE any attempt to hand it to a running child, and
 * removed only when the child actually consumed it. That ordering is the whole
 * point: a child whose turn ends before the guidance reaches a round boundary
 * keeps the directive for its next resume instead of losing it to an in-memory
 * queue that the turn's cleanup discards. It is the same durability rule the
 * A2A mailboxes follow — acknowledge on consumption, never on enqueue.
 *
 * Kept separate from `A2AAgentMessageMailbox` rather than folded into it: every
 * invariant there is keyed on a CHILD sender (envelope hop accounting, tree
 * budget, sender-title canonicalization, peer re-resolution on peek). A parent
 * has no childSessionId, so sharing that store would mean a sender-kind branch
 * in each of those checks — four fail-open surfaces added to the path that
 * carries sibling messages, to save one small file.
 */
import { randomUUID } from "node:crypto";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import { PARENT_DIRECTIVE_MAX_PENDING } from "./parent-directive.js";
import { hasNonWhitespaceControlChars } from "../shared/display-safe-text.js";

const DIRECTIVE_FILE = "parent-directives.json";
const DIRECTIVE_VERSION = 1 as const;

export interface ParentDirectiveEntry {
  id: string;
  createdAt: string;
  /** Root session that authored the directive; re-checked at drain time. */
  originSessionId: string;
  childSessionId: string;
  /** Host-formatted envelope, ready to inject verbatim. */
  text: string;
}

interface PersistedParentDirectives {
  version: typeof DIRECTIVE_VERSION;
  entries: ParentDirectiveEntry[];
}

const ENTRY_KEYS = new Set([
  "id",
  "createdAt",
  "originSessionId",
  "childSessionId",
  "text",
]);

type ParentDirectiveAppendResult =
  | { ok: true; entry: ParentDirectiveEntry }
  | { ok: false; reason: "pending-cap" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !hasNonWhitespaceControlChars(value);
}

function normalizeEntry(value: unknown): ParentDirectiveEntry | null {
  if (
    !isRecord(value)
    || Object.keys(value).length !== ENTRY_KEYS.size
    || !Object.keys(value).every((key) => ENTRY_KEYS.has(key))
    || !isSafeString(value.id, 256)
    || !isSafeString(value.createdAt, 64)
    || !isSafeString(value.originSessionId, 256)
    || !isSafeString(value.childSessionId, 256)
    || !isSafeString(value.text, GUIDE_MAX_CHARS)
    || value.originSessionId === value.childSessionId
  ) {
    return null;
  }
  const timestamp = new Date(value.createdAt);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value.createdAt) {
    return null;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    originSessionId: value.originSessionId,
    childSessionId: value.childSessionId,
    text: value.text,
  };
}

/**
 * Rebuild the state from disk, dropping anything that fails its own shape.
 *
 * The per-child cap is applied HERE as well as on append, so a hand-edited or
 * partially-written file can never hand a child more directives than the live
 * path would have accepted. Oldest entries win: they are the ones the parent
 * has been waiting longest to have read.
 */
function normalizeState(raw: unknown): {
  state: PersistedParentDirectives;
  requiresCleanup: boolean;
} {
  if (!isRecord(raw) || raw.version !== DIRECTIVE_VERSION || !Array.isArray(raw.entries)) {
    return {
      state: { version: DIRECTIVE_VERSION, entries: [] },
      requiresCleanup: true,
    };
  }
  const entries: ParentDirectiveEntry[] = [];
  const ids = new Set<string>();
  const perChild = new Map<string, number>();
  let dropped = 0;
  for (const candidate of raw.entries) {
    const entry = normalizeEntry(candidate);
    const pending = entry ? perChild.get(entry.childSessionId) ?? 0 : 0;
    if (!entry || ids.has(entry.id) || pending >= PARENT_DIRECTIVE_MAX_PENDING) {
      dropped += 1;
      continue;
    }
    ids.add(entry.id);
    perChild.set(entry.childSessionId, pending + 1);
    entries.push(entry);
  }
  return {
    state: { version: DIRECTIVE_VERSION, entries },
    requiresCleanup: dropped > 0,
  };
}

/** Durable parent → child directive queue, keyed by recipient child session. */
export class ParentDirectiveMailbox {
  private statePromise: Promise<PersistedParentDirectives> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly namespace: FeatureNamespaceHandle) {}

  private load(): Promise<PersistedParentDirectives> {
    if (this.statePromise) return this.statePromise;
    const promise = this.namespace
      .readJson<unknown>(DIRECTIVE_FILE, { version: DIRECTIVE_VERSION, entries: [] })
      .then(async (raw) => {
        const normalized = normalizeState(raw);
        // A file that needed repair is rewritten immediately; a failure to do so
        // must not be swallowed, or the next writer would base its state on
        // bytes this process already decided were invalid.
        if (normalized.requiresCleanup) {
          await this.namespace.writeJson(DIRECTIVE_FILE, normalized.state);
        }
        return normalized.state;
      });
    this.statePromise = promise;
    void promise.catch(() => {
      if (this.statePromise === promise) this.statePromise = null;
    });
    return promise;
  }

  private mutate<T>(
    operation: (state: PersistedParentDirectives) => { value: T; changed: boolean },
  ): Promise<T> {
    const run = this.mutationTail.then(async () => {
      const loaded = await this.load();
      const draft = structuredClone(loaded);
      const { value, changed } = operation(draft);
      if (changed) {
        await this.namespace.writeJson(DIRECTIVE_FILE, draft);
        this.statePromise = Promise.resolve(draft);
      }
      return value;
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  append(input: Omit<ParentDirectiveEntry, "id" | "createdAt">): Promise<ParentDirectiveAppendResult> {
    return this.mutate<ParentDirectiveAppendResult>((state) => {
      const pending = state.entries.filter((entry) =>
        entry.childSessionId === input.childSessionId).length;
      if (pending >= PARENT_DIRECTIVE_MAX_PENDING) {
        return { value: { ok: false, reason: "pending-cap" } as const, changed: false };
      }
      const entry: ParentDirectiveEntry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        originSessionId: input.originSessionId,
        childSessionId: input.childSessionId,
        text: input.text,
      };
      state.entries.push(entry);
      return { value: { ok: true, entry } as const, changed: true };
    });
  }

  /**
   * Pending directives for one child, oldest first.
   *
   * `originSessionId` is a filter, not a hint: the drain site knows which parent
   * the child belongs to from host-written metadata, and an entry naming a
   * different origin is never delivered on that authority.
   */
  async peek(
    childSessionId: string,
    originSessionId: string,
  ): Promise<ParentDirectiveEntry[]> {
    await this.mutationTail;
    const state = await this.load();
    return state.entries
      .filter((entry) =>
        entry.childSessionId === childSessionId
        && entry.originSessionId === originSessionId)
      .map((entry) => structuredClone(entry));
  }

  acknowledge(childSessionId: string, ids: readonly string[]): Promise<number> {
    const accepted = new Set(ids);
    return this.mutate((state) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) =>
        entry.childSessionId !== childSessionId || !accepted.has(entry.id));
      const removed = before - state.entries.length;
      return { value: removed, changed: removed > 0 };
    });
  }

  /** Drop everything addressed to a child that can no longer read it. */
  discardForChild(childSessionId: string): Promise<number> {
    return this.mutate((state) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) =>
        entry.childSessionId !== childSessionId);
      const removed = before - state.entries.length;
      return { value: removed, changed: removed > 0 };
    });
  }
}
