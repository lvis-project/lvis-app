/**
 * Per-invocation EffectLedger + AsyncLocalStorage threading tests.
 *
 * Pins the host-owned read/write signal that the effect-boundary model is built
 * on (host-classify completion, Phases 1-2 — OBSERVABILITY ONLY):
 *   (a) a read-only set of effects → hasMutatingEffect:false;
 *   (b) any write effect → hasMutatingEffect:true;
 *   (c) `runWithEffectLedger` binds the right ledger for the async chain;
 *   (d) nested scopes do NOT double-count onto the outer ledger;
 *   (e) `recordEffect` outside any scope is a silent no-op;
 *   (f) each invocation gets a distinct correlationId (no cross-invocation leak).
 */
import { describe, it, expect } from "vitest";
import {
  createEffectLedger,
  runWithEffectLedger,
  currentEffectLedger,
  recordEffect,
  recordChokepoint,
} from "../effect-ledger.js";
import { CHOKEPOINT_EFFECT } from "../effect-kind.js";

describe("createEffectLedger — read/write summary", () => {
  it("classifies a read-only invocation as non-mutating", () => {
    const ledger = createEffectLedger();
    ledger.record({ kind: "config.get", effect: "read", target: "x" });
    ledger.record({ kind: "getSecret", effect: "read" });
    ledger.record({ kind: "hostFetch", effect: "read", target: "api/me" });
    const summary = ledger.summary();
    expect(summary.hasMutatingEffect).toBe(false);
    expect(summary.effects).toHaveLength(3);
  });

  it("classifies any write effect as mutating", () => {
    const ledger = createEffectLedger();
    ledger.record({ kind: "config.get", effect: "read", target: "x" });
    ledger.record({ kind: "config.set", effect: "write", target: "y" });
    expect(ledger.summary().hasMutatingEffect).toBe(true);
  });

  it("an empty ledger is non-mutating", () => {
    expect(createEffectLedger("pinned-empty").summary()).toEqual({
      correlationId: "pinned-empty",
      hasMutatingEffect: false,
      effects: [],
    });
  });

  it("the summary carries the ledger's correlationId (the cross-shadow join key)", () => {
    const ledger = createEffectLedger("pinned-corr");
    ledger.record({ kind: "config.set", effect: "write" });
    expect(ledger.summary().correlationId).toBe("pinned-corr");
  });

  it("summary returns a defensive copy (mutating it cannot corrupt the ledger)", () => {
    const ledger = createEffectLedger();
    ledger.record({ kind: "config.set", effect: "write" });
    const snap = ledger.summary();
    snap.effects.push({ kind: "config.get", effect: "read" });
    expect(ledger.summary().effects).toHaveLength(1);
  });

  it("assigns a distinct correlationId per ledger", () => {
    const a = createEffectLedger();
    const b = createEffectLedger();
    expect(a.correlationId).toBeTruthy();
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it("honours an explicit correlationId (test pinning)", () => {
    expect(createEffectLedger("pinned-id").correlationId).toBe("pinned-id");
  });
});

describe("runWithEffectLedger — AsyncLocalStorage threading", () => {
  it("binds the ledger so recordEffect lands on it across awaits", async () => {
    const ledger = createEffectLedger();
    await runWithEffectLedger(ledger, async () => {
      expect(currentEffectLedger()).toBe(ledger);
      await Promise.resolve();
      recordEffect({ kind: "config.set", effect: "write", target: "k" });
    });
    expect(ledger.summary().hasMutatingEffect).toBe(true);
  });

  it("does NOT leak the ledger outside the scope", async () => {
    const ledger = createEffectLedger();
    await runWithEffectLedger(ledger, async () => {});
    expect(currentEffectLedger()).toBeUndefined();
    recordEffect({ kind: "config.set", effect: "write" });
    expect(ledger.summary().hasMutatingEffect).toBe(false);
  });

  it("nested scope records onto the inner ledger only — no double-count on the outer", async () => {
    const outer = createEffectLedger();
    const inner = createEffectLedger();
    await runWithEffectLedger(outer, async () => {
      recordEffect({ kind: "callTool", effect: "read", target: "inner_tool" });
      await runWithEffectLedger(inner, async () => {
        recordEffect({ kind: "config.set", effect: "write", target: "mutated" });
      });
      // back in the outer scope
      expect(currentEffectLedger()).toBe(outer);
    });
    // The write happened in the inner invocation, not the outer.
    expect(outer.summary().hasMutatingEffect).toBe(false);
    expect(inner.summary().hasMutatingEffect).toBe(true);
  });

  it("concurrent invocations keep their effects isolated", async () => {
    const l1 = createEffectLedger();
    const l2 = createEffectLedger();
    await Promise.all([
      runWithEffectLedger(l1, async () => {
        await Promise.resolve();
        recordEffect({ kind: "config.get", effect: "read" });
      }),
      runWithEffectLedger(l2, async () => {
        await Promise.resolve();
        recordEffect({ kind: "config.set", effect: "write" });
      }),
    ]);
    expect(l1.summary().hasMutatingEffect).toBe(false);
    expect(l2.summary().hasMutatingEffect).toBe(true);
  });
});

describe("recordEffect — out of scope", () => {
  it("is a silent no-op when no ledger is bound", () => {
    expect(() => recordEffect({ kind: "config.set", effect: "write" })).not.toThrow();
    expect(currentEffectLedger()).toBeUndefined();
  });
});

describe("recordChokepoint — newly instrumented host-mediated mutating chokepoints", () => {
  // Every host-mediated MUTATION chokepoint must classify as a write, else a
  // plugin tool that mutates only through it would record hasMutatingEffect:false
  // = a confirmed host-observed read (fail-open). The SOT pins the classification.
  const WRITE_CHOKEPOINTS = [
    "storageWrite",
    "storageRm",
    "storageMkdir",
    "clearAuthPartition",
    "openAuthWindow",
    "triggerConversation",
    "agentApprovalRespond",
  ] as const;

  it("all newly instrumented mutating chokepoints are classified write in the SOT", () => {
    for (const kind of WRITE_CHOKEPOINTS) {
      expect(CHOKEPOINT_EFFECT[kind]).toBe("write");
    }
    // The storage READ variant records positive read evidence without mutating.
    expect(CHOKEPOINT_EFFECT.storageRead).toBe("read");
  });

  it("recordChokepoint of any mutating chokepoint flips hasMutatingEffect", async () => {
    for (const kind of WRITE_CHOKEPOINTS) {
      const ledger = createEffectLedger();
      await runWithEffectLedger(ledger, async () => {
        recordChokepoint(kind, "t");
      });
      expect(ledger.summary().hasMutatingEffect).toBe(true);
      expect(ledger.summary().effects[0]).toMatchObject({ kind, effect: "write" });
    }
  });

  it("a storageRead alone is a non-mutating, host-observed read", async () => {
    const ledger = createEffectLedger();
    await runWithEffectLedger(ledger, async () => {
      recordChokepoint("storageRead", "data.json");
    });
    const summary = ledger.summary();
    expect(summary.hasMutatingEffect).toBe(false);
    expect(summary.effects).toEqual([{ kind: "storageRead", effect: "read", target: "data.json" }]);
  });
});
