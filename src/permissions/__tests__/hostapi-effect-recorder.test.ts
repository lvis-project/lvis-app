/**
 * hostapi-effect-recorder.test.ts
 *
 * Unit coverage for the structural recording wrapper ({@link
 * instrumentEffectsByPath}) and the per-path target/effect extractors in the
 * classification SOT. Drives recording through wrapped objects and inspects the
 * ambient ledger so every branch — static vs verb-derived effect, each
 * `targetFromArgs` extractor (valid + degenerate), nested-namespace recursion,
 * idempotence, non-namespace passthrough, the fail-closed default, and the
 * "recording never breaks the host" guarantee — is exercised.
 */
import { describe, it, expect } from "vitest";
import { instrumentEffectsByPath } from "../hostapi-effect-recorder.js";
import {
  createEffectLedger,
  runWithEffectLedger,
  type EffectEntry,
  type EffectLedger,
} from "../effect-ledger.js";

/** Wrap `api`, invoke `call(wrapped)` inside a fresh ledger scope, return effects. */
async function record<T extends object>(
  api: T,
  call: (wrapped: T) => void | Promise<void>,
): Promise<EffectEntry[]> {
  const wrapped = instrumentEffectsByPath(api);
  const ledger = createEffectLedger("cid");
  await runWithEffectLedger(ledger, async () => {
    await call(wrapped);
  });
  return ledger.summary().effects;
}

const noop = (..._args: unknown[]): unknown => undefined;

describe("instrumentEffectsByPath — static effect + selfRecorded skip", () => {
  it("records a static READ for a read-classified method", async () => {
    const effects = await record({ getInstalledPluginIds: noop }, (w) => {
      w.getInstalledPluginIds();
    });
    expect(effects).toEqual([{ kind: "getInstalledPluginIds", effect: "read", target: undefined }]);
  });

  it("records a static WRITE for a write-classified method (no target)", async () => {
    const effects = await record({ registerKeywords: noop }, (w) => {
      w.registerKeywords([{ keyword: "k", skillId: "s" }]);
    });
    expect(effects).toEqual([{ kind: "registerKeywords", effect: "write", target: undefined }]);
  });

  it("SKIPS hostFetch — the only verb-derived chokepoint is selfRecorded in its closure", async () => {
    // hostFetch's effect depends on the HTTP verb (a plugin-controlled arg
    // VALUE). The generic recorder must NOT re-read that value (a second,
    // independent read is the value-divergence forgery vector), so it records
    // NOTHING here — the real hostFetch host closure snapshots the verb ONCE and
    // records the effect + pins the wire from that single read. The end-to-end
    // single-read guarantee is covered in host-fetch-verb-snapshot.test.ts.
    const post = await record({ hostFetch: noop }, (w) => {
      w.hostFetch("https://api.example.com/x?token=secret", { method: "POST" });
    });
    expect(post).toEqual([]);

    const get = await record({ hostFetch: noop }, (w) => {
      w.hostFetch("https://api.example.com/x");
    });
    expect(get).toEqual([]);
  });
});

describe("instrumentEffectsByPath — target extractors (valid + degenerate)", () => {
  it("firstStringArg — string key vs non-string", async () => {
    const ok = await record({ config: { get: noop } }, (w) => {
      w.config.get("theme");
    });
    expect(ok).toEqual([{ kind: "config.get", effect: "read", target: "theme" }]);

    const bad = await record({ config: { get: noop } }, (w) => {
      (w.config.get as (k: unknown) => unknown)(123);
    });
    expect(bad[0].target).toBeUndefined();
  });

  it("cappedKeyArg — caps the key NAME to 64 chars; non-string → undefined", async () => {
    const long = await record({ getSecret: noop }, (w) => {
      w.getSecret("k".repeat(200));
    });
    expect(long[0].target).toHaveLength(64);

    const nonString = await record({ getSecret: noop }, (w) => {
      (w.getSecret as (k: unknown) => unknown)({});
    });
    expect(nonString[0].target).toBeUndefined();
  });

  it("urlOriginArg — origin-only; invalid URL → undefined", async () => {
    const ok = await record({ openExternalUrl: noop }, (w) => {
      w.openExternalUrl("https://host.example.com/path?q=1#h");
    });
    expect(ok[0].target).toBe("https://host.example.com");

    const bad = await record({ openExternalUrl: noop }, (w) => {
      w.openExternalUrl("::not a url::");
    });
    expect(bad[0].target).toBeUndefined();
  });

  it("urlOriginFromOpts — opts.url origin; missing/invalid → undefined", async () => {
    const ok = await record({ openAuthWindow: noop }, (w) => {
      w.openAuthWindow({ url: "https://login.example.com/oauth?code=abc" });
    });
    expect(ok[0].target).toBe("https://login.example.com");

    const noUrl = await record({ openAuthWindow: noop }, (w) => {
      (w.openAuthWindow as (o: unknown) => unknown)({});
    });
    expect(noUrl[0].target).toBeUndefined();

    const badUrl = await record({ openAuthPartitionViewer: noop }, (w) => {
      w.openAuthPartitionViewer({ url: "nope" });
    });
    expect(badUrl[0].target).toBeUndefined();
  });

  it("objectStringField — present field vs absent", async () => {
    const source = await record({ triggerConversation: noop }, (w) => {
      w.triggerConversation({ source: "overlay:meeting", prompt: "x" });
    });
    expect(source).toEqual([{ kind: "triggerConversation", effect: "write", target: "overlay:meeting" }]);

    const absent = await record({ triggerConversation: noop }, (w) => {
      (w.triggerConversation as (s: unknown) => unknown)({ prompt: "x" });
    });
    expect(absent[0].target).toBeUndefined();

    const purpose = await record({ resolveApiKey: noop }, (w) => {
      w.resolveApiKey({ purpose: "stt" });
    });
    expect(purpose[0].target).toBe("stt");
  });

  it("spawnWorker target scopes worker identity, command, and filesystem grants", async () => {
    const effects = await record({ spawnWorker: noop }, (w) => {
      w.spawnWorker({
        workerId: "embed",
        command: "C:/Python/python.exe",
        allowReadPaths: ["C:/worker.py", "C:/Python/python.exe", "C:/worker.py"],
        allowWritePaths: ["C:/index"],
      });
    });

    expect(effects[0]).toMatchObject({ kind: "spawnWorker", effect: "write" });
    expect(JSON.parse(effects[0].target ?? "{}")).toEqual({
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowRead: ["C:/Python/python.exe", "C:/worker.py"],
      allowWrite: ["C:/index"],
    });
  });

  it("spawnWorker target keeps malformed object specs target-scoped", async () => {
    const effects = await record({ spawnWorker: noop }, (w) => {
      w.spawnWorker({});
    });

    expect(effects[0]).toMatchObject({ kind: "spawnWorker", effect: "write" });
    expect(JSON.parse(effects[0].target ?? "{}")).toEqual({
      workerId: "",
      command: "",
      allowRead: [],
      allowWrite: [],
    });
  });

  it("spawnWorker target keeps non-object specs target-scoped", async () => {
    const effects = await record({ spawnWorker: noop }, (w) => {
      (w.spawnWorker as (spec: unknown) => unknown)("not-a-spec");
    });

    expect(effects[0]).toMatchObject({ kind: "spawnWorker", effect: "write" });
    expect(JSON.parse(effects[0].target ?? "{}")).toEqual({
      workerId: "",
      command: "",
      allowRead: [],
      allowWrite: [],
      invalidSpec: true,
    });
  });
});

describe("instrumentEffectsByPath — recursion, idempotence, passthrough", () => {
  it("records nested namespace methods under their dotted PATH", async () => {
    const effects = await record(
      { agentApproval: { request: noop, respond: noop } },
      (w) => {
        w.agentApproval.request({ scope: "agent_task_delegate" });
        w.agentApproval.respond("req-1", "allow-once");
      },
    );
    expect(effects).toEqual([
      { kind: "agentApprovalRequest", effect: "write", target: "agent_task_delegate" },
      { kind: "agentApprovalRespond", effect: "write", target: undefined },
    ]);
  });

  it("is idempotent — re-wrapping an instrumented object returns it unchanged", () => {
    const once = instrumentEffectsByPath({ getInstalledPluginIds: noop });
    expect(instrumentEffectsByPath(once)).toBe(once);
  });

  it("passes non-function / non-namespace values through unchanged (no recursion)", async () => {
    class NotANamespace {
      doThing(): string {
        return "x";
      }
    }
    const instance = new NotANamespace();
    const array = [1, 2, 3];
    const wrapped = instrumentEffectsByPath({
      n: 5,
      data: array,
      instance,
      getInstalledPluginIds: noop,
    });
    expect(wrapped.n).toBe(5);
    expect(wrapped.data).toBe(array); // same reference, not recursed/copied deeply
    expect(wrapped.instance).toBe(instance); // class instance is NOT treated as a namespace
    expect(typeof wrapped.getInstalledPluginIds).toBe("function");
  });
});

describe("instrumentEffectsByPath — fail-closed default + purity", () => {
  it("records an UNMAPPED method fail-closed as a mutating unclassifiedHostApiMethod (warn once)", async () => {
    // Called TWICE so both the first-warn and already-warned branches run.
    const effects = await record({ brandNewMethod: noop }, (w) => {
      (w as { brandNewMethod: () => unknown }).brandNewMethod();
      (w as { brandNewMethod: () => unknown }).brandNewMethod();
    });
    expect(effects).toEqual([
      { kind: "unclassifiedHostApiMethod", effect: "write", target: "brandNewMethod" },
      { kind: "unclassifiedHostApiMethod", effect: "write", target: "brandNewMethod" },
    ]);
  });

  it("delegates with EXACT behavior — args, return, this-binding, async, throw", async () => {
    const seen: unknown[][] = [];
    const api = instrumentEffectsByPath({
      config: {
        get(this: { tag: string }, ...args: unknown[]): unknown {
          seen.push(args);
          return "v";
        },
      },
      callLlm: async (prompt: string): Promise<string> => {
        if (prompt === "boom") throw new Error("nope");
        return `echo:${prompt}`;
      },
    });
    expect(api.config.get("k")).toBe("v");
    expect(seen).toEqual([["k"]]);
    await expect(api.callLlm("hi")).resolves.toBe("echo:hi");
    await expect(api.callLlm("boom")).rejects.toThrow("nope");
  });

  it("is a no-op outside any ledger scope (never throws, records nothing)", () => {
    const wrapped = instrumentEffectsByPath({ registerKeywords: noop });
    expect(() => wrapped.registerKeywords([])).not.toThrow();
  });

  it("recording never breaks the host — a throwing ledger.record is swallowed", async () => {
    const wrapped = instrumentEffectsByPath({ registerKeywords: () => "ok" });
    const explodingLedger: EffectLedger = {
      correlationId: "boom",
      record() {
        throw new Error("ledger exploded");
      },
      summary() {
        return { correlationId: "boom", hasMutatingEffect: false, effects: [] };
      },
    };
    let ret: unknown;
    await runWithEffectLedger(explodingLedger, async () => {
      ret = wrapped.registerKeywords([]);
    });
    expect(ret).toBe("ok"); // method still ran + returned despite the recording failure
  });
});

describe("instrumentEffectsByPath — a hostile arg getter cannot suppress the effect signal", () => {
  /** An object whose named property THROWS on access (a hostile getter). */
  const throwingField = (field: string): Record<string, unknown> => ({
    get [field](): never {
      throw new Error(`hostile ${field} getter`);
    },
  });

  it("triggerConversation: a throwing spec.source getter costs only the target, never the write effect", async () => {
    const effects = await record({ triggerConversation: noop }, (w) => {
      (w.triggerConversation as (s: unknown) => unknown)(throwingField("source"));
    });
    expect(effects).toEqual([{ kind: "triggerConversation", effect: "write", target: undefined }]);
  });

  it("openAuthWindow: a throwing opts.url getter still records the write effect", async () => {
    const effects = await record({ openAuthWindow: noop }, (w) => {
      (w.openAuthWindow as (o: unknown) => unknown)(throwingField("url"));
    });
    expect(effects).toEqual([{ kind: "openAuthWindow", effect: "write", target: undefined }]);
  });

  it("agentApproval.request: a throwing input.scope getter still records the write effect", async () => {
    const effects = await record({ agentApproval: { request: noop } }, (w) => {
      (w.agentApproval.request as (i: unknown) => unknown)(throwingField("scope"));
    });
    expect(effects).toEqual([{ kind: "agentApprovalRequest", effect: "write", target: undefined }]);
  });

  it("the suppression-resistant record flips hasMutatingEffect to true", async () => {
    const wrapped = instrumentEffectsByPath({ triggerConversation: noop });
    const ledger = createEffectLedger("cid-hostile");
    await runWithEffectLedger(ledger, async () => {
      // A throwing target getter costs only the forensic descriptor — the static
      // write effect is already on the ledger, so the plugin cannot hide its write.
      (wrapped.triggerConversation as (s: unknown) => unknown)(throwingField("source"));
    });
    expect(ledger.summary().hasMutatingEffect).toBe(true); // a plugin cannot hide its own write
  });
});

describe("instrumentEffectsByPath — non-plain namespace is left UNINSTRUMENTED (the gap the completeness test guards)", () => {
  it("copies a class-instance namespace verbatim — its methods record nothing", async () => {
    class CustomProtoNamespace {
      // class field → an OWN-enumerable function property, but the prototype is
      // CustomProtoNamespace.prototype (NOT Object.prototype) → non-plain.
      doMutation = (): string => "mutated";
    }
    const instance = new CustomProtoNamespace();
    const effects = await record(
      { ns: instance, getInstalledPluginIds: noop } as Record<string, unknown>,
      (w) => {
        // verbatim-copied namespace → the method is NOT wrapped → records nothing
        (w.ns as CustomProtoNamespace).doMutation();
        (w.getInstalledPluginIds as () => unknown)();
      },
    );
    // Only the instrumented top-level method recorded; the non-plain namespace's
    // method left no effect — exactly why the completeness test rejects such a
    // namespace so it can never ship.
    expect(effects).toEqual([{ kind: "getInstalledPluginIds", effect: "read", target: undefined }]);
  });
});
