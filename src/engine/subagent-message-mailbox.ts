import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { A2AMessage } from "../shared/a2a.js";
import { maskSensitiveData } from "../shared/dlp.js";
import {
  canonicalizeAgentMessage,
  isSafeA2AMessageId,
} from "./a2a-subagent-message-codec.js";
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

export type ParentMailboxLoadDiagnosticReason =
  | "cross-origin"
  | "invalid-message"
  | "budget-exhausted";

export interface ParentMailboxLoadDiagnostic {
  reason: ParentMailboxLoadDiagnosticReason;
  parentSessionId?: string;
  childSessionId?: string;
  messageId?: string;
}

export interface ParentMailboxPeekResult {
  entries: ParentMailboxEntry[];
  diagnostics: ParentMailboxLoadDiagnostic[];
  cleanupFailed: boolean;
}

interface NormalizedParentMailbox {
  state: PersistedParentMailbox;
  diagnostics: ParentMailboxLoadDiagnostic[];
  requiresCleanup: boolean;
}

interface LoadedParentMailbox extends NormalizedParentMailbox {
  cleanupFailed: boolean;
}

export type ParentMailboxEnqueueResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "duplicate-message"
        | "message-too-long"
        | "mailbox-entry-budget"
        | "mailbox-char-budget"
        | "tracked-parent-budget";
    };

const MAILBOX_ENTRY_KEYS = new Set([
  "id",
  "parentSessionId",
  "childSessionId",
  "childTitle",
  "createdAt",
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

function isSafeDiagnosticStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

function diagnosticFor(
  value: unknown,
  reason: ParentMailboxLoadDiagnosticReason,
): ParentMailboxLoadDiagnostic {
  const diagnostic: ParentMailboxLoadDiagnostic = { reason };
  if (!isRecord(value) || !isSafeDiagnosticStructuralId(value.parentSessionId)) {
    return diagnostic;
  }
  diagnostic.parentSessionId = value.parentSessionId;
  if (isSafeDiagnosticStructuralId(value.childSessionId)) {
    diagnostic.childSessionId = value.childSessionId;
  }
  if (isRecord(value.message) && isSafeA2AMessageId(value.message.messageId)) {
    diagnostic.messageId = value.message.messageId;
  }
  return diagnostic;
}

function normalizeMailboxEntry(
  value: unknown,
): { entry: ParentMailboxEntry | null; reason?: ParentMailboxLoadDiagnosticReason } {
  if (!isRecord(value)
    || !Object.keys(value).every((key) => MAILBOX_ENTRY_KEYS.has(key))
    || !isSafeString(value.id, 256)
    || !isSafeString(value.parentSessionId, 256)
    || !isSafeString(value.childSessionId, 256)
    || !isSafeString(value.childTitle, 256)
    || !isSafeString(value.createdAt, 64)
    || !isSafeString(value.formattedText)
    || !isSafeString(value.approvalLabel, 512)) {
    return { entry: null, reason: "invalid-message" };
  }
  const timestamp = new Date(value.createdAt);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value.createdAt) {
    return { entry: null, reason: "invalid-message" };
  }
  if (isRecord(value.message)
    && typeof value.message.contextId === "string"
    && value.message.contextId !== value.parentSessionId) {
    return { entry: null, reason: "cross-origin" };
  }

  const canonical = canonicalizeAgentMessage({
    parentSessionId: value.parentSessionId,
    childSessionId: value.childSessionId,
    childTitle: value.childTitle,
  }, value.message);
  if (!canonical.ok
    || canonical.detectionCount !== 0
    || canonical.childTitle !== value.childTitle
    || canonical.approvalLabel !== value.approvalLabel
    || canonical.formattedText !== value.formattedText) {
    return { entry: null, reason: "invalid-message" };
  }

  let serializedMessage: string;
  try {
    serializedMessage = JSON.stringify(canonical.message);
  } catch {
    return { entry: null, reason: "invalid-message" };
  }
  if (serializedMessage.length > GUIDE_MAX_CHARS) {
    return { entry: null, reason: "budget-exhausted" };
  }

  return {
    entry: {
      id: value.id,
      parentSessionId: value.parentSessionId,
      childSessionId: value.childSessionId,
      childTitle: canonical.childTitle,
      createdAt: value.createdAt,
      message: canonical.message,
      formattedText: canonical.formattedText,
      approvalLabel: canonical.approvalLabel,
    },
  };
}

function semanticMessageKey(entry: ParentMailboxEntry): string {
  return JSON.stringify([
    entry.parentSessionId,
    entry.childSessionId,
    entry.message.contextId,
    entry.message.messageId,
  ]);
}

function normalizeMailbox(raw: unknown): NormalizedParentMailbox {
  if (!isRecord(raw) || raw.version !== MAILBOX_VERSION || !Array.isArray(raw.entries)) {
    return {
      state: { version: MAILBOX_VERSION, entries: [] },
      diagnostics: [{ reason: "invalid-message" }],
      requiresCleanup: true,
    };
  }

  const entries: ParentMailboxEntry[] = [];
  const diagnostics: ParentMailboxLoadDiagnostic[] = [];
  const parentIds = new Set<string>();
  const perParentCount = new Map<string, number>();
  const perParentChars = new Map<string, number>();
  const idMultiplicity = new Map<string, number>();
  const semanticKeys = new Set<string>();

  for (const candidate of raw.entries) {
    if (!isRecord(candidate) || !isSafeString(candidate.id, 256)) continue;
    idMultiplicity.set(candidate.id, (idMultiplicity.get(candidate.id) ?? 0) + 1);
  }

  for (const candidate of raw.entries) {
    if (isRecord(candidate)
      && isSafeString(candidate.id, 256)
      && (idMultiplicity.get(candidate.id) ?? 0) > 1) {
      diagnostics.push(diagnosticFor(candidate, "invalid-message"));
      continue;
    }

    const normalized = normalizeMailboxEntry(candidate);
    const entry = normalized.entry;
    if (!entry) {
      diagnostics.push(diagnosticFor(candidate, normalized.reason ?? "invalid-message"));
      continue;
    }

    const semanticKey = semanticMessageKey(entry);
    if (semanticKeys.has(semanticKey)) {
      diagnostics.push(diagnosticFor(candidate, "invalid-message"));
      continue;
    }

    const parentId = entry.parentSessionId;
    if (!parentIds.has(parentId) && parentIds.size >= MAX_TRACKED_PARENT_MAILBOXES) {
      diagnostics.push(diagnosticFor(candidate, "budget-exhausted"));
      continue;
    }

    const count = perParentCount.get(parentId) ?? 0;
    if (count >= GUIDE_MAX_ENTRIES) {
      diagnostics.push(diagnosticFor(candidate, "budget-exhausted"));
      continue;
    }

    const priorChars = perParentChars.get(parentId) ?? 0;
    const separatorChars = count > 0 ? 2 : 0;
    const nextChars = priorChars + separatorChars + entry.formattedText.length;
    if (nextChars > GUIDE_JOINED_MAX_CHARS) {
      diagnostics.push(diagnosticFor(candidate, "budget-exhausted"));
      continue;
    }

    semanticKeys.add(semanticKey);
    parentIds.add(parentId);
    perParentCount.set(parentId, count + 1);
    perParentChars.set(parentId, nextChars);
    entries.push(structuredClone(entry));
  }

  return {
    state: { version: MAILBOX_VERSION, entries },
    diagnostics,
    requiresCleanup: diagnostics.length > 0,
  };
}

/**
 * Durable, parent-session-keyed mailbox for A2A child messages.
 *
 * No timer is created here. Messages remain until acknowledged by a receiving
 * turn; GUIDE_MAX_* bounds and a tracked-parent ceiling make overflow fail
 * closed without inventing the ph3 wire TTL.
 */
export class SubAgentMessageMailbox {
  private statePromise: Promise<LoadedParentMailbox> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private loadDiagnosticsReported = false;

  constructor(private readonly namespace: FeatureNamespaceHandle) {}

  private load(): Promise<LoadedParentMailbox> {
    if (this.statePromise) return this.statePromise;

    this.loadDiagnosticsReported = false;
    const loadPromise = this.namespace
      .readJson<unknown>(MAILBOX_FILE, { version: MAILBOX_VERSION, entries: [] })
      .then(async (raw) => {
        const normalized = normalizeMailbox(raw);
        if (!normalized.requiresCleanup) {
          return { ...normalized, cleanupFailed: false };
        }
        try {
          await this.namespace.writeJson(MAILBOX_FILE, normalized.state);
          return {
            ...normalized,
            requiresCleanup: false,
            cleanupFailed: false,
          };
        } catch {
          return { ...normalized, cleanupFailed: true };
        }
      });
    this.statePromise = loadPromise;
    void loadPromise.then(
      (loaded) => {
        if (loaded.cleanupFailed && this.statePromise === loadPromise) {
          this.statePromise = null;
        }
      },
      () => {
        if (this.statePromise === loadPromise) {
          this.statePromise = null;
        }
      },
    );
    return loadPromise;
  }

  private mutate<T>(
    operation: (state: PersistedParentMailbox) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const run = this.mutationTail.then(async () => {
      const loaded = await this.load();
      if (loaded.cleanupFailed) {
        throw new Error("mailbox-cleanup-failed");
      }
      const draft = structuredClone(loaded.state);
      const { value, changed } = await operation(draft);
      if (changed) {
        await this.namespace.writeJson(MAILBOX_FILE, draft);
        this.statePromise = Promise.resolve({
          ...loaded,
          state: draft,
          requiresCleanup: false,
        });
      }
      return value;
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
  enqueue(entry: ParentMailboxEntry): Promise<ParentMailboxEnqueueResult> {
    return this.mutate<ParentMailboxEnqueueResult>(async (state) => {
      const duplicate = state.entries.some(
        (candidate) => candidate.id === entry.id
          || semanticMessageKey(candidate) === semanticMessageKey(entry),
      );
      if (duplicate) {
        return { value: { ok: false, reason: "duplicate-message" } as const, changed: false };
      }

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
    const loaded = await this.load();
    return this.entriesForParent(loaded, parentSessionId);
  }

  async peekWithDiagnostics(parentSessionId: string): Promise<ParentMailboxPeekResult> {
    await this.mutationTail;
    const loaded = await this.load();
    const diagnostics = loaded.cleanupFailed || this.loadDiagnosticsReported
      ? []
      : loaded.diagnostics.map((diagnostic) => structuredClone(diagnostic));
    if (!loaded.cleanupFailed) {
      this.loadDiagnosticsReported = true;
    }
    return {
      entries: this.entriesForParent(loaded, parentSessionId),
      diagnostics,
      cleanupFailed: loaded.cleanupFailed,
    };
  }

  private entriesForParent(
    loaded: LoadedParentMailbox,
    parentSessionId: string,
  ): ParentMailboxEntry[] {
    if (loaded.cleanupFailed) return [];
    return loaded.state.entries
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
