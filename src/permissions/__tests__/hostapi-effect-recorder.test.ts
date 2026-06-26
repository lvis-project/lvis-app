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

describe("instrumentEffectsByPath — static vs verb-derived effect", () => {
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

  it("derives hostFetch effect from the HTTP verb (POST=write, default GET=read)", async () => {
    const post = await record({ hostFetch: noop }, (w) => {
      w.hostFetch("https://api.example.com/x?token=secret", { method: "POST" });
    });
    expect(post).toEqual([{ kind: "hostFetch", effect: "write", target: "https://api.example.com" }]);

    const get = await record({ hostFetch: noop }, (w) => {
      w.hostFetch("https://api.example.com/x");
    });
    expect(get).toEqual([{ kind: "hostFetch", effect: "read", target: "https://api.example.com" }]);

    const emptyMethod = await record({ hostFetch: noop }, (w) => {
      w.hostFetch("https://api.example.com/x", { method: "" });
    });
    expect(emptyMethod[0].effect).toBe("read");

    // URL-object input → origin extractor returns undefined (string-only).
    const urlObj = await record({ hostFetch: noop }, (w) => {
      w.hostFetch(new URL("https://api.example.com"));
    });
    expect(urlObj).toEqual([{ kind: "hostFetch", effect: "read" }]);
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
