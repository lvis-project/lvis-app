import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemorySecretStore,
  type SecretStore,
} from "../../../audit/hmac-chain.js";
import { writeUtf8FileAtomicSync } from "../../../lib/atomic-file.js";
import { canonicalStringify } from "../../../shared/canonical-json.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import {
  DurableHostInvocationStartCasStore,
  type DurableHostInvocationStartCasStoreOptions,
} from "../rationale-invocation-journal.js";
import {
  createInvocationAuditEvent,
  transitionInvocationAudit,
  type HostInvocationStartCommit,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";

const directories: string[] = [];
const TEST_SECRET = "rationale-invocation-journal-test-secret-v1";
const CHECKPOINT_A = "rationale-invocation-journal-checkpoint-v1-a";
const CHECKPOINT_B = "rationale-invocation-journal-checkpoint-v1-b";
const JOURNAL_HEAD = "rationale-invocation-journal-head-v1";
const sealStoresByPath = new Map<string, MemorySecretStore>();

class SwitchableSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  failNextWrite = false;
  failNextName: string | null = null;

  read(name: string, maxBytes = 1024 * 1024): string | null {
    const value = this.values.get(name);
    if (value === undefined) return null;
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      throw new Error("secret authority value exceeds read byte limit");
    }
    return value;
  }

  write(name: string, value: string): void {
    if (this.failNextWrite || this.failNextName === name) {
      this.failNextWrite = false;
      this.failNextName = null;
      throw new Error("checkpoint write unavailable");
    }
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

type JournalOptionsOverrides = Partial<
  Omit<DurableHostInvocationStartCasStoreOptions, "filePath">
>;

function journalOptions(
  filePath: string,
  overrides: JournalOptionsOverrides = {},
): DurableHostInvocationStartCasStoreOptions {
  let sealStore: SecretStore | undefined = overrides.sealStore;
  if (!sealStore) {
    let stored = sealStoresByPath.get(filePath);
    if (!stored) {
      stored = new MemorySecretStore();
      sealStoresByPath.set(filePath, stored);
    }
    sealStore = stored;
  }
  return {
    filePath,
    auditSecret: TEST_SECRET,
    sealStore,
    ...overrides,
  };
}

function journalStore(
  filePath: string,
  overrides: JournalOptionsOverrides = {},
): DurableHostInvocationStartCasStore {
  return new DurableHostInvocationStartCasStore(
    journalOptions(filePath, overrides),
  );
}

function persistedSnapshot(filePath: string): {
  revision: number;
  entries: Record<string, Record<string, unknown>>;
} {
  return (JSON.parse(readFileSync(filePath, "utf8")) as {
    snapshot: {
      revision: number;
      entries: Record<string, Record<string, unknown>>;
    };
  }).snapshot;
}

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "lvis-invocation-journal-"));
  directories.push(value);
  return value;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

const controlsByInvocation = new Map<string, RationaleRequiredControl>();

function authorized(
  value: number,
  options: {
    now?: number;
    ttlMs?: number;
    sessionId?: string;
  } = {},
): InvocationAuditRecord {
  const now = options.now ?? 0;
  const sessionId = options.sessionId ?? `session-tool-${value}`;
  const toolUseId = `tool-${value}`;
  const anchor = createRequestAnchor({
    sessionId,
    turnId: `turn-${value}`,
    inputMessageId: `message-${value}`,
    inputOrigin: "user-keyboard",
    rawIntent: `perform operation ${value}`,
    now,
    ttlMs: options.ttlMs ?? 10_000,
  });
  if (!anchor) throw new Error("expected test request anchor");
  const finalInput = { command: `raw-secret-command-${value}` };
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName: "bash",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    finalInput,
    canonicalTargets: [`workspace/target-${value}`],
    requestedEffects: ["execute-command"],
    affectedResources: [`workspace/target-${value}`],
    requiredAuthority: "shell",
    policyEpoch: "policy-1",
    registryGeneration: "registry-1",
    sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  const batch = createTriggeringBatchDisposition({
    batchId: `batch-${value}`,
    originalToolUseIds: [toolUseId],
    triggeringToolUseId: toolUseId,
    completedToolUseIds: [],
  });
  const anchorCas = new InMemoryHostAnchorRoundCasStore();
  const reservation = anchorCas.tryReserve({
    anchor,
    action,
    triggeringBatchDisposition: batch,
    round: 1,
    now,
  });
  if (!reservation) throw new Error("expected test anchor reservation");
  const control = createRationaleRequiredControl({
    anchor,
    action,
    triggeringBatchDisposition: batch,
    anchorRoundReservation: reservation,
    hostAnchorRoundCas: anchorCas,
    sealedAction: {
      toolUseId,
      toolName: "bash",
      originalInput: finalInput,
      finalInput,
    },
    eligibilityContext: {
      headless: false,
      forceModal: false,
      approvalReasonPrefix: null,
    },
    permission: {
      decision: "ask",
      reason: "reviewer medium",
      layer: 5,
      reviewer: {
        route: "foreground-auto",
        verdict: { level: "medium", reason: "bounded command" },
        outcome: "fresh",
      },
    },
    now,
  });
  const record: InvocationAuditRecord = {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    invocationDigest: control.invocationDigest,
    toolUseId,
    authorizationReceiptId: uuid(30_000 + value),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
  };
  controlsByInvocation.set(record.invocationDigest, control);
  return record;
}

function controlFor(record: InvocationAuditRecord): RationaleRequiredControl {
  const control = controlsByInvocation.get(record.invocationDigest);
  if (!control) throw new Error("missing test rationale control");
  return control;
}

function terminal(
  commit: HostInvocationStartCommit,
  event: "complete" | "fail" | "crash-recovery" = "complete",
): InvocationAuditRecord {
  return transitionInvocationAudit(
    commit.startedInvocationAudit,
    createInvocationAuditEvent(commit.startedInvocationAudit, event),
  );
}

afterEach(() => {
  controlsByInvocation.clear();
  sealStoresByPath.clear();
  for (const value of directories.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("DurableHostInvocationStartCasStore", () => {
  it("grants exactly one concurrent start across store instances", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const first = journalStore(filePath);
    const second = journalStore(filePath);
    const record = authorized(1, { sessionId: "session-one" });
    const audits: InvocationAuditRecord[] = [];

    const results = await Promise.all([
      first.commitStart({
        sessionId: "session-one",
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,
        persistAudit: (audit) => { audits.push(audit); },
        now: 100,
      }),
      second.commitStart({
        sessionId: "session-one",
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,
        persistAudit: (audit) => { audits.push(audit); },
        now: 100,
      }),
    ]);

    expect(results.filter((value) => value !== null)).toHaveLength(1);
    expect(audits.map((audit) => audit.state)).toEqual(["authorized", "started"]);

    const persisted = readFileSync(filePath, "utf8");
    expect(persisted).not.toContain("raw-secret-command");
    const snapshot = persistedSnapshot(filePath);
    expect(snapshot.entries[record.invocationDigest]?.sessionId).toBe("session-one");
    expect(Object.keys(snapshot.entries[record.invocationDigest] ?? {}).sort()).toEqual([
      "authorizationExpiresAt",
      "authorized",
      "controlDigest",
      "lease",
      "pendingAuditVersions",
      "sessionId",
      "started",
      "terminal",
      "updatedAt",
    ]);
    if (platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(`${filePath}.lock-target`).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps a failed start projection non-executable and recovers unknown in the original session", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const record = authorized(2, { sessionId: "original-session" });
    const store = journalStore(filePath);
    const toolExecuted = false;

    await expect(store.commitStart({
      sessionId: "original-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: (audit) => {
        if (audit.version === 1) throw new Error("audit unavailable");
      },
      now: 200,
    })).rejects.toThrow("audit unavailable");
    expect(toolExecuted).toBe(false);

    const recovered: Array<{ sessionId: string; record: InvocationAuditRecord }> = [];
    const restarted = journalStore(filePath);
    const result = await restarted.recoverAfterCrash({
      persistAudit: (sessionId, audit) => {
        recovered.push({ sessionId, record: audit });
      },
      now: 300,
    });

    expect(result).toEqual({ recovered: 1, delivered: 2 });
    expect(recovered.map(({ sessionId }) => sessionId)).toEqual([
      "original-session",
      "original-session",
    ]);
    expect(recovered.map(({ record: audit }) => audit.state)).toEqual([
      "started",
      "unknown-after-crash",
    ]);
    expect(await restarted.commitStart({
      sessionId: "original-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 301,
    })).toBeNull();
  });

  it("replays an identical audit record after append succeeds but delivery marking fails", async () => {
    const root = directory();
    const filePath = join(root, "at-least-once-projection.json");
    const sealStore = new SwitchableSecretStore();
    let writeCount = 0;
    const failDeliveryMarkWriter: typeof writeUtf8FileAtomicSync = (
      path,
      content,
      mode,
    ) => {
      writeCount += 1;
      if (writeCount === 3) throw new Error("delivery mark unavailable");
      writeUtf8FileAtomicSync(path, content, mode);
    };
    const firstProjection: InvocationAuditRecord[] = [];
    const record = authorized(26, { sessionId: "at-least-once-session" });
    const store = journalStore(filePath, {
      sealStore,
      writeFileAtomic: failDeliveryMarkWriter,
    });

    await expect(store.commitStart({
      sessionId: "at-least-once-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: (audit) => { firstProjection.push(audit); },
      now: 200,
    })).rejects.toThrow("delivery mark unavailable");
    expect(firstProjection.map((audit) => audit.state)).toEqual(["authorized"]);

    const replayed: InvocationAuditRecord[] = [];
    await expect(journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: (_sessionId, audit) => { replayed.push(audit); },
      now: 300,
    })).resolves.toEqual({ recovered: 1, delivered: 3 });
    expect(replayed.map((audit) => audit.state)).toEqual([
      "authorized",
      "started",
      "unknown-after-crash",
    ]);
    expect(canonicalStringify(replayed[0])).toBe(
      canonicalStringify(firstProjection[0]),
    );
    expect(replayed[0]).toMatchObject({
      invocationDigest: record.invocationDigest,
      version: 0,
    });
  });

  it("persists terminal state before projection and never downgrades it on recovery", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const record = authorized(3, { sessionId: "terminal-session" });
    const store = journalStore(filePath, { now: () => 400 });
    const commit = await store.commitStart({
      sessionId: "terminal-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 400,
    });
    if (!commit) throw new Error("expected committed start");
    const completed = terminal(commit);

    expect(await store.commitTerminal({
      lease: commit.lease,
      terminal: completed,
      persistAudit: () => { throw new Error("audit unavailable"); },
    })).toBe(false);

    const beforeRecovery = persistedSnapshot(filePath);
    expect((beforeRecovery.entries[record.invocationDigest]?.terminal as
      InvocationAuditRecord | null)?.state).toBe("completed");
    expect(beforeRecovery.entries[record.invocationDigest]?.pendingAuditVersions)
      .toEqual([2]);

    const projected: InvocationAuditRecord[] = [];
    const result = await journalStore(filePath)
      .recoverAfterCrash({
        persistAudit: (sessionId, audit) => {
          expect(sessionId).toBe("terminal-session");
          projected.push(audit);
        },
        now: 500,
      });
    expect(result).toEqual({ recovered: 0, delivered: 1 });
    expect(projected.map((audit) => audit.state)).toEqual(["completed"]);
  });

  it("fails closed on corruption without replacing the journal", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    writeFileSync(filePath, "{not-json", "utf8");
    const store = journalStore(filePath);

    await expect(store.recoverAfterCrash({
      persistAudit: () => {},
      now: 600,
    })).rejects.toThrow(/corrupt/);
    expect(readFileSync(filePath, "utf8")).toBe("{not-json");
  });

  it("rejects unsigned and HMAC-tampered journal replacements", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath);
    await store.recoverAfterCrash({ persistAudit: () => {}, now: 10 });
    const signedGenesis = readFileSync(filePath, "utf8");

    writeFileSync(filePath, canonicalStringify({
      schemaVersion: 1,
      revision: 0,
      entries: {},
    }) + "\n", "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/envelope/);

    writeFileSync(filePath, signedGenesis, "utf8");
    const record = authorized(20, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => { throw new Error("hold pending audits"); },
      now: 100,
    })).rejects.toThrow("hold pending audits");
    const signedActive = readFileSync(filePath, "utf8");
    const cleared = JSON.parse(signedActive) as {
      snapshot: { entries: Record<string, unknown> };
    };
    cleared.snapshot.entries = {};
    writeFileSync(filePath, canonicalStringify(cleared) + "\n", "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 101,
    })).rejects.toThrow(/HMAC mismatch/);

    writeFileSync(filePath, signedActive, "utf8");
    const pendingCleared = JSON.parse(signedActive) as {
      snapshot: {
        entries: Record<string, { pendingAuditVersions: number[] }>;
      };
    };
    pendingCleared.snapshot.entries[record.invocationDigest]!
      .pendingAuditVersions = [];
    writeFileSync(
      filePath,
      canonicalStringify(pendingCleared) + "\n",
      "utf8",
    );
    await expect(journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 102,
    })).rejects.toThrow(/HMAC mismatch/);
  });

  it("fails closed when either the journal or its checkpoint authority is missing", async () => {
    const root = directory();
    const journalMissingPath = join(root, "journal-missing.json");
    await journalStore(journalMissingPath).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    unlinkSync(journalMissingPath);
    await expect(journalStore(journalMissingPath).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/missing behind its checkpoint/);

    const checkpointMissingPath = join(root, "checkpoint-missing.json");
    await journalStore(checkpointMissingPath).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    await expect(journalStore(checkpointMissingPath, {
      sealStore: new MemorySecretStore(),
    }).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/checkpoint is absent/);
  });

  it("fails closed when the sealed head is deleted", async () => {
    const root = directory();
    const filePath = join(root, "head-missing.json");
    const sealStore = new SwitchableSecretStore();
    await journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    sealStore.delete(JOURNAL_HEAD);

    await expect(journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/head is absent/);
  });

  it("rejects a tampered checkpoint even when the journal is intact", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    await journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    const sealStore = sealStoresByPath.get(filePath);
    if (!sealStore) throw new Error("expected journal seal store");
    const raw = sealStore.read(CHECKPOINT_A);
    if (raw === null) throw new Error("expected journal checkpoint");
    const tampered = JSON.parse(raw) as { journalMac: string };
    tampered.journalMac = "0".repeat(64);
    sealStore.write(CHECKPOINT_A, canonicalStringify(tampered));

    await expect(journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/checkpoint seal mismatch/);
  });

  it("bounds checkpoint and head authority before JSON parsing", async () => {
    const root = directory();
    const filePath = join(root, "bounded-authority.json");
    const sealStore = new SwitchableSecretStore();
    await journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    const checkpoint = sealStore.read(CHECKPOINT_A);
    const head = sealStore.read(JOURNAL_HEAD);
    if (checkpoint === null || head === null) {
      throw new Error("expected initialized journal authority");
    }

    sealStore.write(CHECKPOINT_A, "x".repeat(4 * 1024 + 1));
    await expect(journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/read byte limit/);

    sealStore.write(CHECKPOINT_A, checkpoint);
    sealStore.write(JOURNAL_HEAD, "x".repeat(4 * 1024 + 1));
    await expect(journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 12,
    })).rejects.toThrow(/read byte limit/);
  });

  it("detects rollback to an earlier valid signed journal", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath);
    const record = authorized(21, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => { throw new Error("retain first signed revision"); },
      now: 100,
    })).rejects.toThrow("retain first signed revision");
    const earlierSignedJournal = readFileSync(filePath, "utf8");

    await store.recoverAfterCrash({
      persistAudit: () => {},
      now: 200,
    });
    writeFileSync(filePath, earlierSignedJournal, "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({
      persistAudit: () => {},
      now: 201,
    })).rejects.toThrow(/rollback detected/);
  });

  it("detects genesis rollback after the newest checkpoint slot is deleted", async () => {
    const root = directory();
    const filePath = join(root, "slot-deletion-rollback.json");
    const sealStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { sealStore });
    await store.recoverAfterCrash({ persistAudit: () => {}, now: 10 });
    const genesisJournal = readFileSync(filePath, "utf8");

    const record = authorized(23, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => { throw new Error("retain revision one"); },
      now: 100,
    })).rejects.toThrow("retain revision one");
    expect(sealStore.read(CHECKPOINT_B)).not.toBeNull();

    sealStore.delete(CHECKPOINT_B);
    writeFileSync(filePath, genesisJournal, "utf8");
    await expect(journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 101,
    })).rejects.toThrow(/head is ahead of available checkpoint/);
  });

  it("repairs a one-revision crash-ahead journal without replaying the start", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const sealStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { sealStore });
    await store.recoverAfterCrash({ persistAudit: () => {}, now: 10 });

    const record = authorized(22, { now: 100, ttlMs: 10_000 });
    sealStore.failNextWrite = true;
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow("checkpoint write unavailable");

    const projected: InvocationAuditRecord[] = [];
    const restarted = journalStore(filePath, { sealStore });
    await expect(restarted.recoverAfterCrash({
      persistAudit: (_sessionId, audit) => projected.push(audit),
      now: 200,
    })).resolves.toEqual({ recovered: 1, delivered: 3 });
    expect(projected.map((audit) => audit.state)).toEqual([
      "authorized",
      "started",
      "unknown-after-crash",
    ]);
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 201,
    })).resolves.toBeNull();
  });

  it("repairs a committed checkpoint when the following head write fails", async () => {
    const root = directory();
    const filePath = join(root, "head-write-crash.json");
    const sealStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { sealStore });
    await store.recoverAfterCrash({ persistAudit: () => {}, now: 10 });
    const genesisHead = sealStore.read(JOURNAL_HEAD);

    const record = authorized(24, { now: 100, ttlMs: 10_000 });
    sealStore.failNextName = JOURNAL_HEAD;
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow("checkpoint write unavailable");
    expect(sealStore.read(CHECKPOINT_B)).not.toBeNull();
    expect(sealStore.read(JOURNAL_HEAD)).toBe(genesisHead);

    const projected: InvocationAuditRecord[] = [];
    const restarted = journalStore(filePath, { sealStore });
    await expect(restarted.recoverAfterCrash({
      persistAudit: (_sessionId, audit) => projected.push(audit),
      now: 200,
    })).resolves.toEqual({ recovered: 1, delivered: 3 });
    expect(projected.map((audit) => audit.state)).toEqual([
      "authorized",
      "started",
      "unknown-after-crash",
    ]);
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 201,
    })).resolves.toBeNull();
  });

  it("does not advance authority after repeated committed atomic-write faults", async () => {
    const root = directory();
    const filePath = join(root, "committed-atomic-fault.json");
    const sealStore = new SwitchableSecretStore();
    await journalStore(filePath, { sealStore }).recoverAfterCrash({
      persistAudit: () => {},
      now: 10,
    });
    const genesisCheckpoint = sealStore.read(CHECKPOINT_A);
    const genesisHead = sealStore.read(JOURNAL_HEAD);
    let remainingFaults = 2;
    const committedFaultWriter: typeof writeUtf8FileAtomicSync = (
      path,
      content,
      mode,
    ) => {
      writeUtf8FileAtomicSync(path, content, mode);
      if (remainingFaults > 0) {
        remainingFaults -= 1;
        const phase = remainingFaults === 1 ? "initial" : "retry";
        throw Object.assign(new Error(`${phase} parent directory sync unavailable`), {
          committed: true as const,
        });
      }
    };
    const store = journalStore(filePath, {
      sealStore,
      writeFileAtomic: committedFaultWriter,
    });
    const record = authorized(25, { now: 100, ttlMs: 10_000 });

    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow("retry parent directory sync unavailable");
    expect(remainingFaults).toBe(0);
    expect(sealStore.read(CHECKPOINT_A)).toBe(genesisCheckpoint);
    expect(sealStore.read(CHECKPOINT_B)).toBeNull();
    expect(sealStore.read(JOURNAL_HEAD)).toBe(genesisHead);

    const projected: InvocationAuditRecord[] = [];
    const restarted = journalStore(filePath, { sealStore });
    await expect(restarted.recoverAfterCrash({
      persistAudit: (_sessionId, audit) => projected.push(audit),
      now: 200,
    })).resolves.toEqual({ recovered: 1, delivered: 3 });
    expect(projected.map((audit) => audit.state)).toEqual([
      "authorized",
      "started",
      "unknown-after-crash",
    ]);
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 201,
    })).resolves.toBeNull();
  });

  it("rejects oversized and truncated authenticated journal files", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath, { maxBytes: 1_024 });
    await store.recoverAfterCrash({ persistAudit: () => {}, now: 10 });
    const valid = readFileSync(filePath, "utf8");

    writeFileSync(filePath, "x".repeat(1_025), "utf8");
    await expect(journalStore(filePath, { maxBytes: 1_024 }).recoverAfterCrash({
      persistAudit: () => {},
      now: 11,
    })).rejects.toThrow(/size is invalid/);

    writeFileSync(filePath, valid.slice(0, -2), "utf8");
    await expect(journalStore(filePath, { maxBytes: 1_024 }).recoverAfterCrash({
      persistAudit: () => {},
      now: 12,
    })).rejects.toThrow(/corrupt|canonical/);
  });

  it.skipIf(platform === "win32")(
    "rejects a final-component symlink replacement",
    async () => {
      const root = directory();
      const filePath = join(root, "invocations.json");
      await journalStore(filePath).recoverAfterCrash({
        persistAudit: () => {},
        now: 10,
      });
      const targetPath = join(root, "replacement.json");
      writeFileSync(targetPath, readFileSync(filePath));
      unlinkSync(filePath);
      symlinkSync(targetPath, filePath);

      await expect(journalStore(filePath).recoverAfterCrash({
        persistAudit: () => {},
        now: 11,
      })).rejects.toThrow(/not a regular file|ELOOP/);
    },
  );

  it("requires the exact unexpired control before creating a journal", async () => {
    const root = directory();
    const record = authorized(7, {
      sessionId: "bound-session",
      now: 100,
      ttlMs: 50,
    });
    const other = authorized(8, {
      sessionId: "other-session",
      now: 100,
      ttlMs: 50,
    });
    const mismatchedPath = join(root, "mismatched.json");
    const mismatched = journalStore(mismatchedPath);

    await expect(mismatched.commitStart({
      sessionId: "bound-session",
      control: controlFor(other),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
    expect(existsSync(mismatchedPath)).toBe(false);

    const expiredPath = join(root, "expired.json");
    const expired = journalStore(expiredPath);
    await expect(expired.commitStart({
      sessionId: "bound-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 150,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
    expect(existsSync(expiredPath)).toBe(false);
  });

  it("reserves terminal headroom and preserves the last authenticated state on size failure", async () => {
    expect(() => journalStore(join(directory(), "too-large.json"), {
      maxBytes: (16 * 1024 * 1024) + 1,
    })).toThrow(/options are invalid/);

    const baselineRoot = directory();
    const baselinePath = join(baselineRoot, "invocations.json");
    const baselineRecord = authorized(9);
    const baselineStore = journalStore(baselinePath);
    const baselineCommit = await baselineStore.commitStart({
      sessionId: controlFor(baselineRecord).anchor.sessionId,
      control: controlFor(baselineRecord),
      authorized: baselineRecord,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    });
    if (!baselineCommit) throw new Error("expected baseline invocation start");
    const baselineBytes = Buffer.byteLength(readFileSync(baselinePath, "utf8"), "utf8");

    const headroomRoot = directory();
    const headroomPath = join(headroomRoot, "invocations.json");
    const headroomRecord = authorized(10);
    const headroomStore = journalStore(headroomPath, {
      maxBytes: baselineBytes + 2_047,
    });
    await expect(headroomStore.commitStart({
      sessionId: controlFor(headroomRecord).anchor.sessionId,
      control: controlFor(headroomRecord),
      authorized: headroomRecord,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow(/size limit/);
    expect(existsSync(headroomPath)).toBe(true);
    expect(persistedSnapshot(headroomPath)).toMatchObject({
      revision: 0,
      entries: {},
    });

    const before = readFileSync(baselinePath, "utf8");
    const cappedStore = journalStore(baselinePath, {
      maxBytes: Buffer.byteLength(before, "utf8") + 100,
    });
    const secondRecord = authorized(11);
    await expect(cappedStore.commitStart({
      sessionId: controlFor(secondRecord).anchor.sessionId,
      control: controlFor(secondRecord),
      authorized: secondRecord,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    })).rejects.toThrow(/size limit/);
    expect(readFileSync(baselinePath, "utf8")).toBe(before);

    expect(await baselineStore.commitTerminal({
      lease: baselineCommit.lease,
      terminal: terminal(baselineCommit),
      persistAudit: () => {},
    })).toBe(true);
  });

  it("admits a start only when its reserved headroom can persist the terminal transition", async () => {
    const sizingRoot = directory();
    const sizingPath = join(sizingRoot, "invocations.json");
    const record = authorized(13, { now: 100, ttlMs: 10_000 });
    const sizingStore = journalStore(sizingPath, {
      now: () => 101,
    });
    await expect(sizingStore.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => { throw new Error("measure pending start"); },
      now: 100,
    })).rejects.toThrow("measure pending start");
    const pendingStartBytes = Buffer.byteLength(readFileSync(sizingPath, "utf8"), "utf8");

    const liveRoot = directory();
    const livePath = join(liveRoot, "invocations.json");
    const liveStore = journalStore(livePath, {
      maxBytes: pendingStartBytes + 2_048,
      now: () => 101,
    });
    const commit = await liveStore.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: 100,
    });
    if (!commit) throw new Error("expected headroom-admitted start");
    expect(await liveStore.commitTerminal({
      lease: commit.lease,
      terminal: terminal(commit),
      persistAudit: () => {},
    })).toBe(true);
  });

  it("compacts an expired delivered terminal under byte pressure below the entry cap", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    let now = 100;
    const generousStore = journalStore(filePath, {
      maxEntries: 10,
      now: () => now,
    });
    const expired = authorized(14, { now: 100, ttlMs: 50 });
    const survivor = authorized(15, { now: 100, ttlMs: 1_000 });

    const expiredCommit = await generousStore.commitStart({
      sessionId: controlFor(expired).anchor.sessionId,
      control: controlFor(expired),
      authorized: expired,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    });
    if (!expiredCommit) throw new Error("expected expired candidate start");
    now = 101;
    expect(await generousStore.commitTerminal({
      lease: expiredCommit.lease,
      terminal: terminal(expiredCommit),
      persistAudit: () => {},
    })).toBe(true);

    now = 120;
    const survivorCommit = await generousStore.commitStart({
      sessionId: controlFor(survivor).anchor.sessionId,
      control: controlFor(survivor),
      authorized: survivor,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    });
    if (!survivorCommit) throw new Error("expected survivor start");
    const beforeBytes = Buffer.byteLength(readFileSync(filePath, "utf8"), "utf8");

    now = 200;
    const candidate = authorized(16, { now, ttlMs: 1_000 });
    const cappedStore = journalStore(filePath, {
      maxEntries: 10,
      maxBytes: beforeBytes + 4_096,
      now: () => now,
    });
    const candidateCommit = await cappedStore.commitStart({
      sessionId: controlFor(candidate).anchor.sessionId,
      control: controlFor(candidate),
      authorized: candidate,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    });
    if (!candidateCommit) throw new Error("expected byte-pressure start");

    const snapshot = persistedSnapshot(filePath);
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(snapshot.entries[expired.invocationDigest]).toBeUndefined();
    expect(snapshot.entries[survivor.invocationDigest]).toBeDefined();
    expect(snapshot.entries[candidate.invocationDigest]).toBeDefined();
    expect(await cappedStore.commitTerminal({
      lease: candidateCommit.lease,
      terminal: terminal(candidateCommit),
      persistAudit: () => {},
    })).toBe(true);
  });

  it("retains delivered terminals through expiry and blocks replay after restart", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    let now = 700;
    const store = journalStore(filePath, {
      maxEntries: 2,
      now: () => now,
    });

    const complete = async (record: InvocationAuditRecord): Promise<void> => {
      const commit = await store.commitStart({
        sessionId: controlFor(record).anchor.sessionId,
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,
        persistAudit: () => {},
        now,
      });
      if (!commit) throw new Error("expected committed start");
      now += 1;
      expect(await store.commitTerminal({
        lease: commit.lease,
        terminal: terminal(commit),
        persistAudit: () => {},
      })).toBe(true);
      now += 1;
    };

    const first = authorized(4, { now: 700, ttlMs: 100 });
    const second = authorized(5, { now: 700, ttlMs: 100 });
    const blockedCandidate = authorized(6, { now: 700, ttlMs: 100 });
    const third = authorized(12, {
      now: 900,
      ttlMs: 1_000,
      sessionId: "session-third",
    });
    await complete(first);
    await complete(second);

    const restarted = journalStore(filePath, {
      maxEntries: 2,
      now: () => now,
    });
    expect(await restarted.commitStart({
      sessionId: controlFor(first).anchor.sessionId,
      control: controlFor(first),
      authorized: first,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    })).toBeNull();
    await expect(restarted.commitStart({
      sessionId: controlFor(blockedCandidate).anchor.sessionId,
      control: controlFor(blockedCandidate),
      authorized: blockedCandidate,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    })).rejects.toThrow(/no safely compactable/);

    now = 900;
    const thirdCommit = await store.commitStart({
      sessionId: "session-third",
      control: controlFor(third),
      authorized: third,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now,
    });
    expect(thirdCommit).not.toBeNull();

    const snapshot = persistedSnapshot(filePath);
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(snapshot.entries[first.invocationDigest]).toBeUndefined();
    await expect(journalStore(filePath).commitStart({
      sessionId: controlFor(first).anchor.sessionId,
      control: controlFor(first),
      authorized: first,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: now + 1,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
  });
});
