/**
 * Recurring headless Layer-1 denial → one user ask, end to end through
 * `ToolExecutor`.
 *
 * The headless lane never prompts: an out-of-allowed-dir call is denied, a
 * deferred entry is queued, and the caller gets a tool error it can retry
 * forever. These tests pin the escalation that interrupts that loop — that it
 * does not fire early, that it fires once, that it fires only for the identity
 * that actually earned it, and that answering "deny" leaves the directory scope
 * exactly where it was.
 *
 * They are deliberately driven through the real executor and the real
 * `ApprovalGate` rather than through the counter, because the thing under test
 * is the wiring: a counter that says "ask" and a runner that never asks would
 * pass every unit test in `permissions/__tests__/layer1-denial-recurrence`.
 */
import { describe, expect, it, vi } from "vitest";

import { ToolExecutor, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { LAYER1_DENIAL_ESCALATION_THRESHOLD } from "../../permissions/layer1-denial-recurrence.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

/** A path no default allowed-directory scope covers. */
function outsidePath(name: string): string {
  return `/var/tmp/lvis-layer1-escalation/${name}.txt`;
}

interface Harness {
  readonly executor: ToolExecutor;
  readonly wc: ReturnType<typeof makeMockWebContents>;
  readonly gate: ApprovalGate;
  readonly executeSpy: ReturnType<typeof vi.fn>;
  readonly turnGrants: string[];
  readonly sessionGrants: string[];
  readonly allowedDirectories: string[];
}

function harness(): Harness {
  const executeSpy = vi.fn(async (_rawInput: unknown) => "read ok");
  const probe: Tool = createDynamicTool({
    name: "escalation_probe",
    description: "Reads a file for the escalation suite.",
    source: "builtin",
    category: "read",
    pathFields: ["path"],
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => ({
      output: String(await executeSpy(rawInput)),
      isError: false,
    }),
  });
  const registry = new ToolRegistry();
  registry.register(probe);
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  return {
    executor: new ToolExecutor(registry, undefined, undefined, undefined, gate),
    wc,
    gate,
    executeSpy,
    turnGrants: [],
    sessionGrants: [],
    allowedDirectories: [],
  };
}

/**
 * A headless permission context whose grant sinks are observable — the same
 * shape the plugin surface builds, including the grant subject the counter is
 * keyed on.
 */
function headlessContext(
  h: Harness,
  grantSubject: string | undefined,
): ToolPermissionContext {
  return {
    trustOrigin: "plugin-emitted",
    headless: true,
    additionalDirectories: h.allowedDirectories,
    getAdditionalDirectories: () => h.allowedDirectories,
    onTurnDirectoryGrant: (dir) => h.turnGrants.push(dir),
    onSessionDirectoryGrant: (dir) => h.sessionGrants.push(dir),
    ...(grantSubject === undefined ? {} : { directoryGrantSubject: grantSubject }),
  };
}

let toolUseCounter = 0;

/** One headless invocation that will hit Layer 1. Resolves when it terminates. */
function denyingCall(
  h: Harness,
  options: { subject: string | undefined; path: string; sessionId?: string },
): Promise<{ is_error?: boolean; content: string }[]> {
  toolUseCounter += 1;
  return h.executor.executeAll(
    [{
      id: `tu-escalation-${toolUseCounter}`,
      name: "escalation_probe",
      input: { path: options.path },
    }],
    {
      sessionId: options.sessionId ?? "sess-escalation",
      permissionContext: headlessContext(h, options.subject),
    },
  );
}

/** Poll the mock renderer channel for the Nth approval request payload. */
async function nthApprovalRequest(
  h: Harness,
  index: number,
): Promise<{
  id: string;
  nonce: string;
  hmac: string;
  kind?: string;
  outOfAllowedDir?: { candidatePath: string; recurringDenialCount?: number };
}> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const payload = h.wc.send.mock.calls[index]?.[1];
    if (payload) return payload as never;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`approval request #${index} was never sent to the renderer`);
}

describe("headless Layer-1 denial escalation — when it fires", () => {
  it("does not ask the user before the threshold", async () => {
    const h = harness();
    const path = outsidePath("steady");

    const results = [];
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      results.push(await denyingCall(h, { subject: "plugin-a", path }));
    }

    // Every sub-threshold denial is the ordinary headless hold, unchanged.
    expect(results.length).toBe(LAYER1_DENIAL_ESCALATION_THRESHOLD - 1);
    for (const [result] of results) {
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("headless");
    }
    expect(h.wc.send).not.toHaveBeenCalled();
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.turnGrants).toEqual([]);
    expect(h.sessionGrants).toEqual([]);
  });

  it("asks the user on the threshold denial, stating the real recurrence count", async () => {
    const h = harness();
    const path = outsidePath("steady");
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path });
    }
    expect(h.wc.send).not.toHaveBeenCalled();

    const pending = denyingCall(h, { subject: "plugin-a", path });
    const request = await nthApprovalRequest(h, 0);

    expect(request.kind).toBe("out-of-allowed-dir");
    expect(request.outOfAllowedDir?.recurringDenialCount).toBe(
      LAYER1_DENIAL_ESCALATION_THRESHOLD,
    );

    h.gate.resolve(request.id, {
      requestId: request.id,
      choice: "deny-once",
      nonce: request.nonce,
      hmac: request.hmac,
    } as never);
    await pending;
  });

  it("marks an ordinary interactive ask with no recurrence count", async () => {
    const h = harness();

    const pending = h.executor.executeAll(
      [{
        id: "tu-escalation-interactive",
        name: "escalation_probe",
        input: { path: outsidePath("interactive") },
      }],
      {
        sessionId: "sess-escalation",
        permissionContext: {
          ...headlessContext(h, "plugin-a"),
          headless: false,
          trustOrigin: "user-keyboard",
        },
      },
    );
    const request = await nthApprovalRequest(h, 0);

    // The interactive card is untouched: it already asks every time, so it must
    // never claim a recurrence.
    expect(request.outOfAllowedDir?.recurringDenialCount).toBeUndefined();

    h.gate.resolve(request.id, {
      requestId: request.id,
      choice: "deny-once",
      nonce: request.nonce,
      hmac: request.hmac,
    } as never);
    await pending;
  });
});

describe("headless Layer-1 denial escalation — what cannot be farmed", () => {
  it("does not add denials from different plugins into one ask", async () => {
    const h = harness();
    const path = outsidePath("shared-target");

    // Threshold-1 denials from one plugin, then one from another: the raw
    // total reaches the threshold and must still not produce a prompt.
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path });
    }
    const [last] = await denyingCall(h, { subject: "plugin-b", path });

    expect(last.is_error).toBe(true);
    expect(last.content).toContain("headless");
    expect(h.wc.send).not.toHaveBeenCalled();
  });

  it("does not add denials for different paths into one ask", async () => {
    const h = harness();

    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path: outsidePath(`file-${i}`) });
    }
    // Same parent directory, different file — the grant the escalation would
    // offer covers the parent, so accumulating these would ask for more
    // authority than the recurrence evidences.
    const [last] = await denyingCall(h, {
      subject: "plugin-a",
      path: outsidePath("file-sibling"),
    });

    expect(last.is_error).toBe(true);
    expect(h.wc.send).not.toHaveBeenCalled();
  });

  it("never asks on behalf of a remote-controller turn", async () => {
    const h = harness();
    const path = outsidePath("remote-driven");

    // A remote-driven turn already has a stricter local rule for directory
    // grants; it must not be able to raise a NEW prompt class at the desk by
    // repeating a refusal.
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD * 2; i += 1) {
      toolUseCounter += 1;
      const [result] = await h.executor.executeAll(
        [{
          id: `tu-escalation-remote-${toolUseCounter}`,
          name: "escalation_probe",
          input: { path },
        }],
        {
          sessionId: "sess-escalation",
          permissionContext: {
            ...headlessContext(h, "plugin-a"),
            remoteControllerAuthority: {
              kind: "tailnet-controller",
              actorId: "tailnet:tester",
            },
          },
        },
      );
      expect(result.is_error).toBe(true);
    }

    expect(h.wc.send).not.toHaveBeenCalled();
  });

  it("never asks for a surface that supplies no grant subject", async () => {
    const h = harness();
    const path = outsidePath("subjectless");

    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD * 2; i += 1) {
      const [result] = await denyingCall(h, { subject: undefined, path });
      expect(result.is_error).toBe(true);
    }

    expect(h.wc.send).not.toHaveBeenCalled();
  });
});

describe("headless Layer-1 denial escalation — how it ends", () => {
  it("leaves the directory scope unchanged when the user declines", async () => {
    const h = harness();
    const path = outsidePath("declined");
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path });
    }

    const pending = denyingCall(h, { subject: "plugin-a", path });
    const request = await nthApprovalRequest(h, 0);
    h.gate.resolve(request.id, {
      requestId: request.id,
      choice: "deny-once",
      nonce: request.nonce,
      hmac: request.hmac,
    } as never);
    const [result] = await pending;

    expect(result.is_error).toBe(true);
    expect(h.executeSpy).not.toHaveBeenCalled();
    // Nothing reached a grant sink, and the scope the next call will read is
    // still the empty one it started with.
    expect(h.turnGrants).toEqual([]);
    expect(h.sessionGrants).toEqual([]);
    expect(h.allowedDirectories).toEqual([]);
  });

  it("does not ask again after a declined escalation", async () => {
    const h = harness();
    const path = outsidePath("declined-then-retried");
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path });
    }
    const pending = denyingCall(h, { subject: "plugin-a", path });
    const request = await nthApprovalRequest(h, 0);
    h.gate.resolve(request.id, {
      requestId: request.id,
      choice: "deny-once",
      nonce: request.nonce,
      hmac: request.hmac,
    } as never);
    await pending;
    expect(h.wc.send).toHaveBeenCalledTimes(1);

    // Enough further denials to cross the threshold all over again.
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD * 2; i += 1) {
      const [result] = await denyingCall(h, { subject: "plugin-a", path });
      expect(result.is_error).toBe(true);
    }

    // Still exactly the one prompt: a refused caller cannot nag its way to a
    // grant by failing three more times.
    expect(h.wc.send).toHaveBeenCalledTimes(1);
  });

  it("routes an accepted escalation through the existing turn-grant sink", async () => {
    const h = harness();
    const path = outsidePath("accepted");
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD - 1; i += 1) {
      await denyingCall(h, { subject: "plugin-a", path });
    }

    const pending = denyingCall(h, { subject: "plugin-a", path });
    const request = await nthApprovalRequest(h, 0);
    h.gate.resolve(request.id, {
      requestId: request.id,
      choice: "allow-once",
      nonce: request.nonce,
      hmac: request.hmac,
    } as never);
    const [result] = await pending;

    // The grant went through the pre-existing propagation path, at the
    // narrowest lifetime the user picked — not through anything new. Only the
    // turn sink was written: "once" must not leak into the session scope.
    expect(h.turnGrants).toEqual([request.outOfAllowedDir?.candidatePath]);
    expect(h.sessionGrants).toEqual([]);
    // And the widening actually took effect — the Layer-1 re-check that follows
    // a grant now passes, so the call the user authorized proceeds.
    expect(result.is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
  });
});
