/**
 * effect-enforcement.test.ts — Phase 3 effect-boundary ENFORCEMENT.
 *
 * Covers the three hard guarantees and the security/UX properties:
 *   • FLAG OFF → no approval, executes exactly as today (byte-for-byte).
 *   • FLAG ON + foreground + write → approval AT THE EFFECT; deny throws + the real
 *     impl never runs; allow proceeds and returns the impl's value.
 *   • FLAG ON + read → never prompts.
 *   • Headless → NO modal (fail-closed throw); the mutation does not execute.
 *   • Dedup → one allow-always/allow-once suppresses repeats for the SAME descriptor,
 *     but a different target still re-prompts (a grant is never widened).
 *   • A throwing arg getter still triggers the gate (no suppression).
 *   • hostFetch is NOT in the generic gated set (it self-gates inline, verb-derived).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ApprovalChoice, ApprovalDecision, ApprovalGate, ApprovalRequest } from "../approval-gate.js";
import {
  enforceMutatingEffects,
  gateMutatingEffect,
  runWithEffectGateContext,
  currentEffectGateContext,
  GATED_ASYNC_WRITE_PATHS,
  EffectBoundaryDeniedError,
  __resetEffectGrantsForTest,
} from "../effect-enforcement.js";

beforeEach(() => {
  __resetEffectGrantsForTest();
});

/** A stub ApprovalGate that records every request and answers with a fixed choice. */
function makeGate(choice: ApprovalChoice | ApprovalChoice[]): {
  gate: ApprovalGate;
  requests: Array<Omit<ApprovalRequest, "requireExplicit">>;
} {
  const requests: Array<Omit<ApprovalRequest, "requireExplicit">> = [];
  const answers = Array.isArray(choice) ? [...choice] : null;
  const gate = {
    requestAndWait: async (
      req: Omit<ApprovalRequest, "requireExplicit">,
    ): Promise<ApprovalDecision> => {
      requests.push(req);
      const next = answers ? (answers.shift() ?? "deny-once") : (choice as ApprovalChoice);
      return { requestId: req.id, choice: next };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

/** A fake per-plugin hostApi whose real impls only log the method they ran. */
function makeApi(log: string[]) {
  return {
    // gated async writes
    triggerConversation: async (_spec: unknown): Promise<{ accepted: boolean }> => {
      log.push("trigger");
      return { accepted: true };
    },
    callLlm: async (_prompt: unknown): Promise<string> => {
      log.push("llm");
      return "resp";
    },
    storage: {
      write: async (_rel: string, _data?: unknown): Promise<void> => {
        log.push("write");
      },
      // gated path but a READ — never prompts (effect from SOT).
      read: async (_rel: string): Promise<string> => {
        log.push("read");
        return "data";
      },
    },
    // a SYNC write chokepoint — NOT gated here (covered by Phase 0), must stay sync.
    registerKeywords: (_kw: unknown): void => {
      log.push("kw");
    },
  };
}

const deps = (gate: ApprovalGate, flag: boolean) => ({
  pluginId: "p1",
  approvalGate: gate,
  flagEnabled: () => flag,
});

describe("enforceMutatingEffects — FLAG OFF = zero behaviour change", () => {
  it("a mutating chokepoint raises NO approval and executes exactly as before", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, false));

    let writeResult: unknown = "sentinel";
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.triggerConversation({ source: "s" });
      writeResult = await api.storage.write("a.txt", "x");
      await api.callLlm("hello");
    });

    expect(requests).toHaveLength(0); // no modal whatsoever
    expect(log).toEqual(["trigger", "write", "llm"]); // every impl ran in order
    expect(writeResult).toBeUndefined(); // identical return value (void)
  });

  it("flag-off passes through even with NO gate context bound (boot-time call)", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, false));
    await api.storage.write("a.txt", "x"); // outside any invocation scope
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["write"]);
  });
});

describe("enforceMutatingEffects — FLAG ON + foreground + write → approval AT THE EFFECT", () => {
  it("ALLOW → the real impl proceeds and returns its value", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    let llmResult: unknown;
    await runWithEffectGateContext({ headless: false, toolName: "meeting_start" }, async () => {
      llmResult = await api.callLlm("hi");
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      source: "plugin",
      sourcePluginId: "p1",
      toolName: "meeting_start",
      approvalScope: "callLlm",
      args: { effect: "write", methodPath: "callLlm" },
    });
    expect(log).toEqual(["llm"]);
    expect(llmResult).toBe("resp");
  });

  it("DENY → throws EffectBoundaryDeniedError and the mutation NEVER executes", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.storage.write("secret.json", "x")).rejects.toBeInstanceOf(
        EffectBoundaryDeniedError,
      );
    });

    expect(requests).toHaveLength(1); // it DID ask
    expect(requests[0].args).toMatchObject({ methodPath: "storage.write", target: "secret.json" });
    expect(log).toEqual([]); // ... and the real write never ran
  });

  it("a nested-namespace WRITE is gated under its dotted PATH", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("notes/a.md", "x");
    });
    expect(requests[0]).toMatchObject({ approvalScope: "storage.write" });
    expect(log).toEqual(["write"]);
  });
});

describe("enforceMutatingEffects — reads never prompt", () => {
  it("a gated-namespace READ method passes through with no approval", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    let v: unknown;
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      v = await api.storage.read("a.txt");
    });
    expect(requests).toHaveLength(0);
    expect(v).toBe("data");
    expect(log).toEqual(["read"]);
  });

  it("a SYNC write chokepoint is NOT gated and stays synchronous (no contract break)", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      const ret = api.registerKeywords([]); // returns void synchronously, not a Promise
      expect(ret).toBeUndefined();
    });
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["kw"]);
  });
});

describe("enforceMutatingEffects — headless = NO modal (fail-closed)", () => {
  it("a write in a headless invocation throws WITHOUT asking and does not execute", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    let caught: unknown;
    await runWithEffectGateContext({ headless: true, toolName: "routine_tool" }, async () => {
      try {
        await api.storage.write("a.txt", "x");
      } catch (err) {
        caught = err;
      }
    });

    expect(requests).toHaveLength(0); // a modal is impossible headless — never asked
    expect(caught).toBeInstanceOf(EffectBoundaryDeniedError);
    expect((caught as EffectBoundaryDeniedError).reason).toBe("headless");
    expect(log).toEqual([]); // fail-closed: the mutation did NOT run
  });
});

describe("enforceMutatingEffects — dedup (one grant ends repeats, never widened)", () => {
  it("allow-always suppresses repeat modals for the SAME descriptor", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("a.txt", "2");
      await api.storage.write("a.txt", "3");
    });
    expect(requests).toHaveLength(1); // one "always" ended the repeats
    expect(log).toEqual(["write", "write", "write"]);
  });

  it("allow-once dedups N writes to one target WITHIN a single invocation", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("a.txt", "2");
    });
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write", "write"]);
  });

  it("a DIFFERENT target re-prompts — the grant is not widened beyond its descriptor", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("b.txt", "2"); // different target → fresh approval
    });
    expect(requests).toHaveLength(2);
    expect(log).toEqual(["write", "write"]);
  });

  it("deny-always short-circuits a repeat to a throw without re-prompting", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.storage.write("a.txt", "1")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
      await expect(api.storage.write("a.txt", "2")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1); // remembered the deny, did not re-ask
    expect(log).toEqual([]);
  });
});

describe("enforceMutatingEffects — a hostile arg getter cannot suppress the gate", () => {
  it("a throwing spec.source getter still fires the write gate (target falls back to undefined)", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    const hostileSpec = {
      get source(): never {
        throw new Error("hostile getter");
      },
      prompt: "p",
    };
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.triggerConversation(hostileSpec);
    });
    expect(requests).toHaveLength(1); // the gate fired despite the throwing getter
    expect(requests[0].args).toEqual({ effect: "write", methodPath: "triggerConversation" }); // no target
    expect(log).toEqual(["trigger"]);
  });
});

describe("gateMutatingEffect — direct unit behaviour", () => {
  it("flag OFF → returns without asking", async () => {
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await gateMutatingEffect({
        pluginId: "p1",
        methodPath: "storage.write",
        effect: "write",
        target: "a",
        approvalGate: gate,
        flagEnabled: () => false,
      });
    });
    expect(requests).toHaveLength(0);
  });

  it("read effect → returns without asking even when the flag is ON", async () => {
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await gateMutatingEffect({
        pluginId: "p1",
        methodPath: "hostFetch",
        effect: "read",
        target: "https://x",
        approvalGate: gate,
        flagEnabled: () => true,
      });
    });
    expect(requests).toHaveLength(0);
  });

  it("no gate context bound → returns without asking (out-of-invocation hostApi call)", async () => {
    const { gate, requests } = makeGate("deny-once");
    expect(currentEffectGateContext()).toBeUndefined();
    await gateMutatingEffect({
      pluginId: "p1",
      methodPath: "hostFetch",
      effect: "write",
      target: "https://x",
      approvalGate: gate,
      flagEnabled: () => true,
    });
    expect(requests).toHaveLength(0);
  });
});

describe("GATED_ASYNC_WRITE_PATHS — curated async-only membership", () => {
  it("contains the design's async write chokepoints and EXCLUDES the verb-derived hostFetch + sync writes", () => {
    for (const p of [
      "storage.write",
      "storage.writeJson",
      "storage.rm",
      "storage.mkdir",
      "openAuthWindow",
      "openAuthPartitionViewer",
      "clearAuthPartition",
      "callLlm",
      "spawnWorker",
      "triggerConversation",
      "agentApproval.request",
    ]) {
      expect(GATED_ASYNC_WRITE_PATHS.has(p)).toBe(true);
    }
    // hostFetch self-gates inline (verb-derived); these are sync / Phase-0-covered.
    for (const p of ["hostFetch", "registerKeywords", "config.set", "openExternalUrl", "agentApproval.respond"]) {
      expect(GATED_ASYNC_WRITE_PATHS.has(p)).toBe(false);
    }
  });
});
