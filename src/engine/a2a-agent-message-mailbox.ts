import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { A2AMessage } from "../shared/a2a.js";
import {
  canonicalizeAgentMessage,
  isSafeA2AMessageId,
  sanitizeA2ALabel,
} from "./a2a-subagent-message-codec.js";
import {
  A2A_AGENT_MAX_HOPS,
  A2A_AGENT_MAX_TRACKED_TREES,
  A2A_AGENT_TREE_MESSAGE_BUDGET,
  type A2AAgentMessageEnvelope,
  type A2AAgentRouteDraft,
  isA2AAgentMessageEnvelope,
  isSafeA2AStructuralId,
} from "./a2a-agent-message-envelope.js";
import {
  GUIDE_JOINED_MAX_CHARS,
  GUIDE_MAX_CHARS,
  GUIDE_MAX_ENTRIES,
} from "./turn/guidance-limits.js";

const MAILBOX_FILE = "agent-mailbox.json";
const MAILBOX_VERSION = 1 as const;

interface A2ATreeCounter {
  originSessionId: string;
  messageCount: number;
}

export interface A2AAgentMailboxEntry {
  id: string;
  createdAt: string;
  envelope: A2AAgentMessageEnvelope;
  senderTitle: string;
  recipientTitle: string;
  message: A2AMessage;
  formattedText: string;
  approvalLabel: string;
}

export type A2AAgentMailboxDraft = Omit<A2AAgentMailboxEntry, "envelope"> & {
  envelope: A2AAgentMessageEnvelope;
};

interface PersistedA2AAgentMailbox {
  version: typeof MAILBOX_VERSION;
  entries: A2AAgentMailboxEntry[];
  trees: A2ATreeCounter[];
}

export type A2AAgentMailboxDiagnosticReason =
  | "cross-origin"
  | "invalid-message"
  | "budget-exhausted";

export interface A2AAgentMailboxDiagnostic {
  reason: A2AAgentMailboxDiagnosticReason;
  originSessionId?: string;
  senderChildSessionId?: string;
  recipientChildSessionId?: string;
  messageId?: string;
}

export interface A2AAgentMailboxPeekResult {
  entries: A2AAgentMailboxEntry[];
  diagnostics: A2AAgentMailboxDiagnostic[];
  cleanupFailed: boolean;
}

interface LoadedMailbox {
  state: PersistedA2AAgentMailbox;
  diagnostics: A2AAgentMailboxDiagnostic[];
  cleanupFailed: boolean;
}

export type A2AEnvelopeAllocationResult =
  | { ok: true; envelope: A2AAgentMessageEnvelope }
  | { ok: false; reason: "hop-limit" | "tree-budget" | "tracked-tree-budget" };

export type A2AOriginActivityResolver = (
  originSessionId: string,
) => boolean | Promise<boolean>;

export type A2AAgentMailboxEnqueueResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "duplicate-message"
        | "message-too-long"
        | "mailbox-entry-budget"
        | "mailbox-char-budget";
    };

const ENTRY_KEYS = new Set([
  "id",
  "createdAt",
  "envelope",
  "senderTitle",
  "recipientTitle",
  "message",
  "formattedText",
  "approvalLabel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeString(value: unknown, maxLength = GUIDE_MAX_CHARS): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function diagnosticFor(
  value: unknown,
  reason: A2AAgentMailboxDiagnosticReason,
): A2AAgentMailboxDiagnostic {
  const out: A2AAgentMailboxDiagnostic = { reason };
  if (!isRecord(value) || !isRecord(value.envelope)) return out;
  const envelope = value.envelope;
  if (isSafeA2AStructuralId(envelope.originSessionId)) {
    out.originSessionId = envelope.originSessionId;
  }
  if (isSafeA2AStructuralId(envelope.senderChildSessionId)) {
    out.senderChildSessionId = envelope.senderChildSessionId;
  }
  if (isSafeA2AStructuralId(envelope.recipientChildSessionId)) {
    out.recipientChildSessionId = envelope.recipientChildSessionId;
  }
  if (isRecord(value.message) && isSafeA2AMessageId(value.message.messageId)) {
    out.messageId = value.message.messageId;
  }
  return out;
}

function semanticKey(entry: A2AAgentMailboxEntry): string {
  return JSON.stringify([
    entry.envelope.originSessionId,
    entry.envelope.senderChildSessionId,
    entry.envelope.recipientChildSessionId,
    entry.message.contextId,
    entry.message.messageId,
  ]);
}

function normalizeEntry(
  value: unknown,
  treeCounts: ReadonlyMap<string, number>,
): { entry: A2AAgentMailboxEntry | null; reason?: A2AAgentMailboxDiagnosticReason } {
  if (
    !isRecord(value)
    || !Object.keys(value).every((key) => ENTRY_KEYS.has(key))
    || Object.keys(value).length !== ENTRY_KEYS.size
    || !isSafeString(value.id, 256)
    || !isSafeString(value.createdAt, 64)
    || !isSafeString(value.senderTitle, 256)
    || !isSafeString(value.recipientTitle, 256)
    || !isSafeString(value.formattedText)
    || !isSafeString(value.approvalLabel, 512)
    || !isA2AAgentMessageEnvelope(value.envelope)
  ) {
    return { entry: null, reason: "invalid-message" };
  }

  const timestamp = new Date(value.createdAt);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value.createdAt) {
    return { entry: null, reason: "invalid-message" };
  }

  const envelope = value.envelope;
  if (
    envelope.senderChildSessionId === envelope.recipientChildSessionId
    || !isRecord(value.message)
    || value.message.contextId !== envelope.originSessionId
    || value.message.taskId !== envelope.senderChildSessionId
  ) {
    return { entry: null, reason: "cross-origin" };
  }
  const treeCount = treeCounts.get(envelope.originSessionId);
  if (treeCount === undefined || envelope.treeSequence > treeCount) {
    return { entry: null, reason: "budget-exhausted" };
  }

  const canonical = canonicalizeAgentMessage({
    parentSessionId: envelope.originSessionId,
    childSessionId: envelope.senderChildSessionId,
    childTitle: value.senderTitle,
  }, value.message);
  const recipientTitle = sanitizeA2ALabel(value.recipientTitle);
  if (
    !canonical.ok
    || canonical.detectionCount !== 0
    || canonical.childTitle !== value.senderTitle
    || canonical.formattedText !== value.formattedText
    || canonical.approvalLabel !== value.approvalLabel
    || recipientTitle !== value.recipientTitle
  ) {
    return { entry: null, reason: "invalid-message" };
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(canonical.message);
  } catch {
    return { entry: null, reason: "invalid-message" };
  }
  if (serialized.length > GUIDE_MAX_CHARS) {
    return { entry: null, reason: "budget-exhausted" };
  }

  return {
    entry: {
      id: value.id,
      createdAt: value.createdAt,
      envelope: structuredClone(envelope),
      senderTitle: canonical.childTitle,
      recipientTitle,
      message: canonical.message,
      formattedText: canonical.formattedText,
      approvalLabel: canonical.approvalLabel,
    },
  };
}

function normalizeMailbox(raw: unknown): {
  state: PersistedA2AAgentMailbox;
  diagnostics: A2AAgentMailboxDiagnostic[];
  requiresCleanup: boolean;
} {
  if (
    !isRecord(raw)
    || raw.version !== MAILBOX_VERSION
    || !Array.isArray(raw.entries)
    || !Array.isArray(raw.trees)
  ) {
    return {
      state: { version: MAILBOX_VERSION, entries: [], trees: [] },
      diagnostics: [{ reason: "invalid-message" }],
      requiresCleanup: true,
    };
  }

  const diagnostics: A2AAgentMailboxDiagnostic[] = [];
  const treeCounts = new Map<string, number>();
  for (const candidate of raw.trees) {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).length !== 2
      || !isSafeA2AStructuralId(candidate.originSessionId)
      || !Number.isInteger(candidate.messageCount)
      || (candidate.messageCount as number) < 1
      || (candidate.messageCount as number) > A2A_AGENT_TREE_MESSAGE_BUDGET
      || treeCounts.has(candidate.originSessionId)
      || treeCounts.size >= A2A_AGENT_MAX_TRACKED_TREES
    ) {
      diagnostics.push({ reason: "budget-exhausted" });
      continue;
    }
    treeCounts.set(candidate.originSessionId, candidate.messageCount as number);
  }

  const entries: A2AAgentMailboxEntry[] = [];
  const ids = new Set<string>();
  const semantics = new Set<string>();
  const counts = new Map<string, number>();
  const chars = new Map<string, number>();
  for (const candidate of raw.entries) {
    const normalized = normalizeEntry(candidate, treeCounts);
    const entry = normalized.entry;
    if (!entry) {
      diagnostics.push(diagnosticFor(candidate, normalized.reason ?? "invalid-message"));
      continue;
    }
    const key = semanticKey(entry);
    if (ids.has(entry.id) || semantics.has(key)) {
      diagnostics.push(diagnosticFor(candidate, "invalid-message"));
      continue;
    }
    const recipient = entry.envelope.recipientChildSessionId;
    const count = counts.get(recipient) ?? 0;
    const priorChars = chars.get(recipient) ?? 0;
    const nextChars = priorChars + (count > 0 ? 2 : 0) + entry.formattedText.length;
    if (count >= GUIDE_MAX_ENTRIES || nextChars > GUIDE_JOINED_MAX_CHARS) {
      diagnostics.push(diagnosticFor(candidate, "budget-exhausted"));
      continue;
    }
    ids.add(entry.id);
    semantics.add(key);
    counts.set(recipient, count + 1);
    chars.set(recipient, nextChars);
    entries.push(structuredClone(entry));
  }

  return {
    state: {
      version: MAILBOX_VERSION,
      entries,
      trees: [...treeCounts].map(([originSessionId, messageCount]) => ({
        originSessionId,
        messageCount,
      })),
    },
    diagnostics,
    requiresCleanup: diagnostics.length > 0,
  };
}

/** Durable, recipient-child-keyed mailbox plus persistent tree budget ledger. */
export class A2AAgentMessageMailbox {
  private statePromise: Promise<LoadedMailbox> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private diagnosticsReported = false;

  constructor(private readonly namespace: FeatureNamespaceHandle) {}

  private load(): Promise<LoadedMailbox> {
    if (this.statePromise) return this.statePromise;
    this.diagnosticsReported = false;
    const promise = this.namespace
      .readJson<unknown>(MAILBOX_FILE, { version: MAILBOX_VERSION, entries: [], trees: [] })
      .then(async (raw) => {
        const normalized = normalizeMailbox(raw);
        if (!normalized.requiresCleanup) {
          return { ...normalized, cleanupFailed: false };
        }
        try {
          await this.namespace.writeJson(MAILBOX_FILE, normalized.state);
          return { ...normalized, cleanupFailed: false };
        } catch {
          return { ...normalized, cleanupFailed: true };
        }
      });
    this.statePromise = promise;
    void promise.then(
      (loaded) => {
        if (loaded.cleanupFailed && this.statePromise === promise) this.statePromise = null;
      },
      () => {
        if (this.statePromise === promise) this.statePromise = null;
      },
    );
    return promise;
  }

  private mutate<T>(
    operation: (state: PersistedA2AAgentMailbox) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const run = this.mutationTail.then(async () => {
      const loaded = await this.load();
      if (loaded.cleanupFailed) throw new Error("agent-mailbox-cleanup-failed");
      const draft = structuredClone(loaded.state);
      const { value, changed } = await operation(draft);
      if (changed) {
        await this.namespace.writeJson(MAILBOX_FILE, draft);
        this.statePromise = Promise.resolve({
          state: draft,
          diagnostics: loaded.diagnostics,
          cleanupFailed: false,
        });
      }
      return value;
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  allocateEnvelope(
    draft: A2AAgentRouteDraft,
    isOriginActive?: A2AOriginActivityResolver,
  ): Promise<A2AEnvelopeAllocationResult> {
    return this.mutate<A2AEnvelopeAllocationResult>(async (state) => {
      if (draft.hopCount < 1 || draft.hopCount > A2A_AGENT_MAX_HOPS) {
        return { value: { ok: false, reason: "hop-limit" } as const, changed: false };
      }
      let treeIndex = state.trees.findIndex((candidate) =>
        candidate.originSessionId === draft.originSessionId);
      if (treeIndex < 0) {
        if (state.trees.length >= A2A_AGENT_MAX_TRACKED_TREES) {
          if (!isOriginActive) {
            return {
              value: { ok: false, reason: "tracked-tree-budget" } as const,
              changed: false,
            };
          }
          let evictionIndex = -1;
          for (let index = 0; index < state.trees.length; index += 1) {
            const candidateOriginSessionId = state.trees[index]!.originSessionId;
            const hasPendingMessage = state.entries.some((entry) =>
              entry.envelope.originSessionId === candidateOriginSessionId);
            if (hasPendingMessage) continue;

            let active: boolean;
            try {
              active = await isOriginActive(candidateOriginSessionId);
            } catch {
              return {
                value: { ok: false, reason: "tracked-tree-budget" } as const,
                changed: false,
              };
            }
            if (!active) {
              evictionIndex = index;
              break;
            }
          }
          if (evictionIndex < 0) {
            return {
              value: { ok: false, reason: "tracked-tree-budget" } as const,
              changed: false,
            };
          }
          state.trees.splice(evictionIndex, 1);
        }
        state.trees.push({
          originSessionId: draft.originSessionId,
          messageCount: 0,
        });
        treeIndex = state.trees.length - 1;
      }
      const tree = state.trees[treeIndex]!;
      if (tree.messageCount >= A2A_AGENT_TREE_MESSAGE_BUDGET) {
        return { value: { ok: false, reason: "tree-budget" } as const, changed: false };
      }
      tree.messageCount += 1;
      if (treeIndex !== state.trees.length - 1) {
        state.trees.splice(treeIndex, 1);
        state.trees.push(tree);
      }
      return {
        value: {
          ok: true,
          envelope: { ...draft, treeSequence: tree.messageCount },
        } as const,
        changed: true,
      };
    });
  }

  rollbackEnvelope(envelope: A2AAgentMessageEnvelope): Promise<boolean> {
    return this.mutate(async (state) => {
      const treeIndex = state.trees.findIndex((candidate) =>
        candidate.originSessionId === envelope.originSessionId);
      const tree = state.trees[treeIndex];
      if (!tree || tree.messageCount !== envelope.treeSequence) {
        return { value: false, changed: false };
      }
      tree.messageCount -= 1;
      if (tree.messageCount === 0) state.trees.splice(treeIndex, 1);
      return { value: true, changed: true };
    });
  }

  enqueue(entry: A2AAgentMailboxEntry): Promise<A2AAgentMailboxEnqueueResult> {
    return this.mutate<A2AAgentMailboxEnqueueResult>(async (state) => {
      const duplicate = state.entries.some((candidate) =>
        candidate.id === entry.id || semanticKey(candidate) === semanticKey(entry));
      if (duplicate) {
        return { value: { ok: false, reason: "duplicate-message" } as const, changed: false };
      }
      if (entry.formattedText.length > GUIDE_MAX_CHARS) {
        return { value: { ok: false, reason: "message-too-long" } as const, changed: false };
      }
      const recipient = entry.envelope.recipientChildSessionId;
      const existing = state.entries.filter((candidate) =>
        candidate.envelope.recipientChildSessionId === recipient);
      if (existing.length >= GUIDE_MAX_ENTRIES) {
        return { value: { ok: false, reason: "mailbox-entry-budget" } as const, changed: false };
      }
      const joinedChars = existing.reduce(
        (total, candidate, index) => total + candidate.formattedText.length + (index > 0 ? 2 : 0),
        0,
      );
      if (
        joinedChars + (existing.length > 0 ? 2 : 0) + entry.formattedText.length
        > GUIDE_JOINED_MAX_CHARS
      ) {
        return { value: { ok: false, reason: "mailbox-char-budget" } as const, changed: false };
      }
      state.entries.push(structuredClone(entry));
      return { value: { ok: true } as const, changed: true };
    });
  }

  async peekWithDiagnostics(recipientChildSessionId: string): Promise<A2AAgentMailboxPeekResult> {
    await this.mutationTail;
    const loaded = await this.load();
    const diagnostics = loaded.cleanupFailed || this.diagnosticsReported
      ? []
      : loaded.diagnostics.map((diagnostic) => structuredClone(diagnostic));
    if (!loaded.cleanupFailed) this.diagnosticsReported = true;
    return {
      entries: loaded.cleanupFailed
        ? []
        : loaded.state.entries
            .filter((entry) =>
              entry.envelope.recipientChildSessionId === recipientChildSessionId)
            .map((entry) => structuredClone(entry)),
      diagnostics,
      cleanupFailed: loaded.cleanupFailed,
    };
  }

  acknowledge(recipientChildSessionId: string, ids: readonly string[]): Promise<number> {
    const accepted = new Set(ids);
    return this.mutate(async (state) => {
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) =>
        entry.envelope.recipientChildSessionId !== recipientChildSessionId
        || !accepted.has(entry.id));
      const removed = before - state.entries.length;
      return { value: removed, changed: removed > 0 };
    });
  }
}
