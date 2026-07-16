import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import { DurableHostInvocationStartCasStore } from "../rationale-invocation-journal.js";
import {
  createInvocationAuditEvent,
  transitionInvocationAudit,
  type HostInvocationStartCommit,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";

const directories: string[] = [];

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
  for (const value of directories.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("DurableHostInvocationStartCasStore", () => {
  it("grants exactly one concurrent start across store instances", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const first = new DurableHostInvocationStartCasStore({ filePath });
    const second = new DurableHostInvocationStartCasStore({ filePath });
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
    const snapshot = JSON.parse(persisted) as {
      entries: Record<string, Record<string, unknown>>;
    };
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
    const store = new DurableHostInvocationStartCasStore({ filePath });
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
    const restarted = new DurableHostInvocationStartCasStore({ filePath });
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

  it("persists terminal state before projection and never downgrades it on recovery", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const record = authorized(3, { sessionId: "terminal-session" });
    const store = new DurableHostInvocationStartCasStore({ filePath, now: () => 400 });
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

    const beforeRecovery = JSON.parse(readFileSync(filePath, "utf8")) as {
      entries: Record<string, {
        terminal: InvocationAuditRecord | null;
        pendingAuditVersions: number[];
      }>;
    };
    expect(beforeRecovery.entries[record.invocationDigest]?.terminal?.state).toBe("completed");
    expect(beforeRecovery.entries[record.invocationDigest]?.pendingAuditVersions).toEqual([2]);

    const projected: InvocationAuditRecord[] = [];
    const result = await new DurableHostInvocationStartCasStore({ filePath })
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
    const store = new DurableHostInvocationStartCasStore({ filePath });

    await expect(store.recoverAfterCrash({
      persistAudit: () => {},
      now: 600,
    })).rejects.toThrow(/corrupt/);
    expect(readFileSync(filePath, "utf8")).toBe("{not-json");
  });

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
    const mismatched = new DurableHostInvocationStartCasStore({
      filePath: mismatchedPath,
    });

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
    const expired = new DurableHostInvocationStartCasStore({
      filePath: expiredPath,
    });
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

  it("reserves terminal headroom and leaves the raw file unchanged on size failure", async () => {
    expect(() => new DurableHostInvocationStartCasStore({
      filePath: join(directory(), "too-large.json"),
      maxBytes: (16 * 1024 * 1024) + 1,
    })).toThrow(/options are invalid/);

    const baselineRoot = directory();
    const baselinePath = join(baselineRoot, "invocations.json");
    const baselineRecord = authorized(9);
    const baselineStore = new DurableHostInvocationStartCasStore({
      filePath: baselinePath,
    });
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
    const headroomStore = new DurableHostInvocationStartCasStore({
      filePath: headroomPath,
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
    expect(existsSync(headroomPath)).toBe(false);

    const before = readFileSync(baselinePath, "utf8");
    const cappedStore = new DurableHostInvocationStartCasStore({
      filePath: baselinePath,
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
    const sizingStore = new DurableHostInvocationStartCasStore({
      filePath: sizingPath,
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
    const liveStore = new DurableHostInvocationStartCasStore({
      filePath: livePath,
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
    const generousStore = new DurableHostInvocationStartCasStore({
      filePath,
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
    const cappedStore = new DurableHostInvocationStartCasStore({
      filePath,
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

    const snapshot = JSON.parse(readFileSync(filePath, "utf8")) as {
      entries: Record<string, unknown>;
    };
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
    const store = new DurableHostInvocationStartCasStore({
      filePath,
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

    const restarted = new DurableHostInvocationStartCasStore({
      filePath,
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

    const snapshot = JSON.parse(readFileSync(filePath, "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(snapshot.entries[first.invocationDigest]).toBeUndefined();
    await expect(new DurableHostInvocationStartCasStore({ filePath }).commitStart({
      sessionId: controlFor(first).anchor.sessionId,
      control: controlFor(first),
      authorized: first,
      expectedInvocationVersion: 0,
      persistAudit: () => {},
      now: now + 1,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
  });
});
