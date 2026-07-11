import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { A2AMessage } from "../shared/a2a.js";
import {
  GUIDE_JOINED_MAX_CHARS,
  GUIDE_MAX_CHARS,
  GUIDE_MAX_ENTRIES,
} from "./turn/guidance-limits.js";

const MAILBOX_FILE = "parent-mailbox.json";
const MAILBOX_VERSION = 1;
const MAX_TRACKED_PARENT_MAILBOXES = 100;

export interface ParentMailboxEntry {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  createdAt: string;
  message: A2AMessage;
  formattedText: string;
  approvalLabel: string;
}

interface PersistedParentMailbox {
  version: typeof MAILBOX_VERSION;
  entries: ParentMailboxEntry[];
}

export type ParentMailboxEnqueueResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "message-too-long"
        | "mailbox-entry-budget"
        | "mailbox-char-budget"
        | "tracked-parent-budget";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeString(value: unknown, maxLength = GUIDE_MAX_CHARS): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isMailboxEntry(value: unknown): value is ParentMailboxEntry {
  if (!isRecord(value)) return false;
  return isSafeString(value.id, 256)
    && isSafeString(value.parentSessionId, 256)
    && isSafeString(value.childSessionId, 256)
    && isSafeString(value.childTitle, 256)
    && isSafeString(value.createdAt, 64)
    && isSafeString(value.formattedText)
    && isSafeString(value.approvalLabel, 512)
    && isRecord(value.message);
}

function normalizeMailbox(raw: unknown): PersistedParentMailbox {
  if (!isRecord(raw) || raw.version !== MAILBOX_VERSION || !Array.isArray(raw.entries)) {
    return { version: MAILBOX_VERSION, entries: [] };
  }

  const entries: ParentMailboxEntry[] = [];
  const parentIds = new Set<string>();
  const perParentCount = new Map<string, number>();
  const perParentChars = new Map<string, number>();

  for (const candidate of raw.entries) {
    if (!isMailboxEntry(candidate)) continue;
    const parentId = candidate.parentSessionId;
    if (!parentIds.has(parentId) && parentIds.size >= MAX_TRACKED_PARENT_MAILBOXES) continue;

    const count = perParentCount.get(parentId) ?? 0;
    if (count >= GUIDE_MAX_ENTRIES) continue;

    const priorChars = perParentChars.get(parentId) ?? 0;
    const separatorChars = count > 0 ? 2 : 0;
    const nextChars = priorChars + separatorChars + candidate.formattedText.length;
    if (nextChars > GUIDE_JOINED_MAX_CHARS) continue;

    parentIds.add(parentId);
    perParentCount.set(parentId, count + 1);
    perParentChars.set(parentId, nextChars);
    entries.push(structuredClone(candidate));
  }

  return { version: MAILBOX_VERSION, entries };
}

/**
 * Durable, parent-session-keyed mailbox for A2A child messages.
 *
 * No timer is created here. Messages remain until acknowledged by a receiving
 * turn; GUIDE_MAX_* bounds and a tracked-parent ceiling make overflow fail
 * closed without inventing the ph3 wire TTL.
 */
export class SubAgentMessageMailbox {
  private statePromise: Promise<PersistedParentMailbox> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly namespace: FeatureNamespaceHandle) {}

  private load(): Promise<PersistedParentMailbox> {
    this.statePromise ??= this.namespace
      .readJson<unknown>(MAILBOX_FILE, { version: MAILBOX_VERSION, entries: [] })
      .then(normalizeMailbox);
    return this.statePromise;
  }

  private mutate<T>(
    operation: (state: PersistedParentMailbox) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const run = this.mutationTail.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const { value, changed } = await operation(draft);
      if (changed) {
        await this.namespace.writeJson(MAILBOX_FILE, draft);
        this.statePromise = Promise.resolve(draft);
      }
      return value;
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  enqueue(entry: ParentMailboxEntry): Promise<ParentMailboxEnqueueResult> {
    return this.mutate<ParentMailboxEnqueueResult>(async (state) => {
      if (entry.formattedText.length > GUIDE_MAX_CHARS) {
        return { value: { ok: false, reason: "message-too-long" } as const, changed: false };
      }

      const existing = state.entries.filter(
        (candidate) => candidate.parentSessionId === entry.parentSessionId,
      );
      if (existing.length >= GUIDE_MAX_ENTRIES) {
        return { value: { ok: false, reason: "mailbox-entry-budget" } as const, changed: false };
      }

      const joinedChars = existing.reduce(
        (total, candidate, index) =>
          total + candidate.formattedText.length + (index > 0 ? 2 : 0),
        0,
      );
      if (joinedChars + (existing.length > 0 ? 2 : 0) + entry.formattedText.length
        > GUIDE_JOINED_MAX_CHARS) {
        return { value: { ok: false, reason: "mailbox-char-budget" } as const, changed: false };
      }

      const trackedParents = new Set(state.entries.map((candidate) => candidate.parentSessionId));
      if (!trackedParents.has(entry.parentSessionId)
        && trackedParents.size >= MAX_TRACKED_PARENT_MAILBOXES) {
        return { value: { ok: false, reason: "tracked-parent-budget" } as const, changed: false };
      }

      state.entries.push(structuredClone(entry));
      return { value: { ok: true } as const, changed: true };
    });
  }

  async peek(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    await this.mutationTail;
    const state = await this.load();
    return state.entries
      .filter((entry) => entry.parentSessionId === parentSessionId)
      .map((entry) => structuredClone(entry));
  }

  acknowledge(parentSessionId: string, ids: readonly string[]): Promise<number> {
    const accepted = new Set(ids);
    return this.mutate(async (state) => {
      const before = state.entries.length;
      state.entries = state.entries.filter(
        (entry) => entry.parentSessionId !== parentSessionId || !accepted.has(entry.id),
      );
      const removed = before - state.entries.length;
      return { value: removed, changed: removed > 0 };
    });
  }
}
