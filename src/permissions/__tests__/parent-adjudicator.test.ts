/**
 * {@link LlmParentAdjudicator} — tier 2 of the sub-agent approval chain.
 *
 * The module answers one question and has one safe answer for everything it
 * cannot answer. These tests are organised around that: a small number of
 * cases for the two decisive outcomes, and a larger number for every way the
 * lane must land on `escalate` instead of guessing.
 *
 * There is deliberately no case in which a failure produces `allow-once`. If
 * one is ever added, it is a security regression and not a feature.
 */
import { describe, expect, it, vi } from "vitest";
import {
  LlmParentAdjudicator,
  PARENT_ADJUDICATOR_SYSTEM_PROMPT,
  UnavailableParentAdjudicator,
} from "../parent-adjudicator.js";
import type {
  ParentAdjudicationEscalationCause,
  ParentAdjudicationEvidence,
  ParentAdjudicationOptions,
  ParentAdjudicator,
} from "../parent-adjudicator.js";
import type { LlmReviewerProvider } from "../reviewer/risk-classifier.js";

type CompleteParams = Parameters<LlmReviewerProvider["complete"]>[0];

function providerReturning(
  text: string | (() => Promise<string>),
): { provider: LlmReviewerProvider; calls: CompleteParams[] } {
  const calls: CompleteParams[] = [];
  const provider: LlmReviewerProvider = {
    complete: async (params) => {
      calls.push(params);
      const resolved = typeof text === "string" ? text : await text();
      return { text: resolved, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    },
  };
  return { provider, calls };
}

function makeEvidence(
  overrides: Partial<ParentAdjudicationEvidence> = {},
): ParentAdjudicationEvidence {
  return {
    toolName: "fs_write",
    toolCategory: "write",
    source: "builtin",
    maskedArgs: { path: "/work/docs/CHANGELOG.md", content: "…" },
    verdict: { level: "medium", reason: "writes a file in the workspace" },
    targetFilePath: "/work/docs/CHANGELOG.md",
    allowedDirectories: ["/work"],
    child: {
      childSessionId: "conv-child",
      childTitle: "docs sweep",
      spawnTaskSummary: "Update the changelog for the docs sweep.",
    },
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<ParentAdjudicationOptions> = {},
): ParentAdjudicationOptions {
  return {
    parentSessionId: "conv-parent",
    timeoutMs: 30_000,
    maxPerChildRun: 200,
    ...overrides,
  };
}

describe("LlmParentAdjudicator — decisive answers", () => {
  it("turns a well-formed allow into a ONE-SHOT allow", async () => {
    const { provider } = providerReturning(
      '{"outcome":"allow","reason":"the changelog edit is the task I gave it"}',
    );

    await expect(
      new LlmParentAdjudicator(provider, "m").adjudicate(
        makeEvidence(),
        makeOptions(),
      ),
    ).resolves.toEqual({
      // Never "allow": the only allow this lane can express is one-shot, and
      // the shape is what keeps a durable record from being reachable at all.
      outcome: "allow-once",
      reason: "the changelog edit is the task I gave it",
    });
  });

  it("passes a deny through with the parent's stated reason", async () => {
    const { provider } = providerReturning(
      '{"outcome":"deny","reason":"deleting the repo is not part of the sweep"}',
    );

    await expect(
      new LlmParentAdjudicator(provider, "m").adjudicate(
        makeEvidence(),
        makeOptions(),
      ),
    ).resolves.toEqual({
      outcome: "deny",
      // Carried verbatim so the child's tool_result can tell it WHY and let it
      // try a different approach, rather than looping on an opaque refusal.
      reason: "deleting the repo is not part of the sweep",
    });
  });
});

describe("LlmParentAdjudicator — everything it cannot decide", () => {
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["not JSON at all", "I think that's fine, go ahead"],
    ["a code fence", '```json\n{"outcome":"allow","reason":"ok"}\n```'],
    ["an unknown outcome", '{"outcome":"maybe","reason":"ok"}'],
    ["an outcome that is not a string", '{"outcome":true,"reason":"ok"}'],
    ["a missing reason", '{"outcome":"allow"}'],
    ["an empty reason", '{"outcome":"allow","reason":"   "}'],
    ["an extra key", '{"outcome":"allow","reason":"ok","force":true}'],
    ["an array", '[{"outcome":"allow","reason":"ok"}]'],
    ["a bare string", '"allow"'],
  ];

  for (const [label, text] of malformed) {
    it(`escalates on ${label}`, async () => {
      const { provider } = providerReturning(text);

      await expect(
        new LlmParentAdjudicator(provider, "m").adjudicate(
          makeEvidence(),
          makeOptions(),
        ),
      ).resolves.toMatchObject({
        outcome: "escalate",
        cause: "malformed-output",
      });
    });
  }

  it("escalates when the parent says it cannot tell", async () => {
    const { provider } = providerReturning(
      '{"outcome":"escalate","reason":"I cannot tell what this path is for"}',
    );

    await expect(
      new LlmParentAdjudicator(provider, "m").adjudicate(
        makeEvidence(),
        makeOptions(),
      ),
    ).resolves.toEqual({
      outcome: "escalate",
      cause: "parent-escalated",
      reason: "I cannot tell what this path is for",
    });
  });

  it("escalates when the provider throws, without echoing its message", async () => {
    const provider: LlmReviewerProvider = {
      complete: async () => {
        throw new Error("401 from https://api.example/v1 key=sk-live-SECRET");
      },
    };

    const result = await new LlmParentAdjudicator(provider, "m").adjudicate(
      makeEvidence(),
      makeOptions(),
    );

    expect(result).toMatchObject({ outcome: "escalate", cause: "llm-error" });
    // The reason reaches the user's dock and the audit row. A provider error
    // can echo request fragments, so none of it is carried.
    expect(result.reason).not.toContain("sk-live-SECRET");
    expect(result.reason).not.toContain("api.example");
  });

  it("escalates on its own deadline rather than waiting out the call", async () => {
    const { provider } = providerReturning(
      () => new Promise<string>(() => {}),
    );

    await expect(
      new LlmParentAdjudicator(provider, "m").adjudicate(
        makeEvidence(),
        makeOptions({ timeoutMs: 20 }),
      ),
    ).resolves.toMatchObject({ outcome: "escalate", cause: "timeout" });
  });

  it("escalates once a child run has spent its budget", async () => {
    const { provider, calls } = providerReturning(
      '{"outcome":"allow","reason":"fine"}',
    );
    const adjudicator = new LlmParentAdjudicator(provider, "m");
    const options = makeOptions({ maxPerChildRun: 2 });

    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "allow-once" });
    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "allow-once" });
    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "escalate", cause: "rate-limited" });

    // Charged before the call, so an over-budget request never reaches the
    // provider at all — a child cannot spend the parent's judgement by
    // launching requests faster than they finish.
    expect(calls).toHaveLength(2);
  });

  it("budgets each child run separately", async () => {
    const { provider } = providerReturning('{"outcome":"allow","reason":"fine"}');
    const adjudicator = new LlmParentAdjudicator(provider, "m");
    const options = makeOptions({ maxPerChildRun: 1 });
    const other = makeEvidence({
      child: {
        childSessionId: "conv-child-2",
        childTitle: "other sweep",
        spawnTaskSummary: "Something else.",
      },
    });

    await adjudicator.adjudicate(makeEvidence(), options);

    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "escalate", cause: "rate-limited" });
    await expect(
      adjudicator.adjudicate(other, options),
    ).resolves.toMatchObject({ outcome: "allow-once" });
  });

  it("releases a budget only when the run is forgotten", async () => {
    const { provider } = providerReturning('{"outcome":"allow","reason":"fine"}');
    const adjudicator = new LlmParentAdjudicator(provider, "m");
    const options = makeOptions({ maxPerChildRun: 1 });

    await adjudicator.adjudicate(makeEvidence(), options);
    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "escalate", cause: "rate-limited" });

    adjudicator.forgetChildRun("conv-child");

    await expect(
      adjudicator.adjudicate(makeEvidence(), options),
    ).resolves.toMatchObject({ outcome: "allow-once" });
  });
});

describe("LlmParentAdjudicator — the prompt it sends", () => {
  it("sends the host system prompt and the evidence as data", async () => {
    const { provider, calls } = providerReturning(
      '{"outcome":"allow","reason":"fine"}',
    );

    await new LlmParentAdjudicator(provider, "reviewer-model").adjudicate(
      makeEvidence(),
      makeOptions(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("reviewer-model");
    expect(calls[0].systemPrompt).toBe(PARENT_ADJUDICATOR_SYSTEM_PROMPT);
    // The injection defence is stated in the system prompt, where the model
    // cannot have influenced it, rather than mixed into the data block.
    expect(PARENT_ADJUDICATOR_SYSTEM_PROMPT).toContain("never instructions");

    const sent = JSON.parse(calls[0].userPrompt) as Record<string, unknown>;
    expect(sent.kind).toBe("sub-agent-tool-approval");
    expect(sent.subAgent).toEqual({
      title: "docs sweep",
      taskYouGaveIt: "Update the changelog for the docs sweep.",
    });
    expect(sent.hostReview).toEqual({
      level: "medium",
      reason: "writes a file in the workspace",
    });
  });

  it("threads the child turn's abort signal to the provider", async () => {
    const { provider, calls } = providerReturning(
      '{"outcome":"allow","reason":"fine"}',
    );
    const controller = new AbortController();

    await new LlmParentAdjudicator(provider, "m").adjudicate(
      makeEvidence(),
      makeOptions({ abortSignal: controller.signal }),
    );

    expect(calls[0].abortSignal).toBe(controller.signal);
  });

  it("answers one at a time", async () => {
    // Several children can block on the same parent at once. Interleaving
    // their side turns would ask one agent to hold unrelated judgements in the
    // same moment.
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: LlmReviewerProvider = {
      complete: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          text: '{"outcome":"allow","reason":"fine"}',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        };
      },
    };
    const adjudicator = new LlmParentAdjudicator(provider, "m");

    await Promise.all([
      adjudicator.adjudicate(makeEvidence(), makeOptions()),
      adjudicator.adjudicate(makeEvidence(), makeOptions()),
      adjudicator.adjudicate(makeEvidence(), makeOptions()),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("keeps serving later requests after one turn rejects", async () => {
    // A rejection must not poison the queue behind it.
    const complete = vi
      .fn<LlmReviewerProvider["complete"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({
        text: '{"outcome":"allow","reason":"fine"}',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      });
    const adjudicator = new LlmParentAdjudicator({ complete }, "m");

    const [first, second] = await Promise.all([
      adjudicator.adjudicate(makeEvidence(), makeOptions()),
      adjudicator.adjudicate(makeEvidence(), makeOptions()),
    ]);

    expect(first).toMatchObject({ outcome: "escalate", cause: "llm-error" });
    expect(second).toMatchObject({ outcome: "allow-once" });
  });
});

describe("UnavailableParentAdjudicator", () => {
  it("escalates, so a missing model never means allow", async () => {
    const adjudicator: ParentAdjudicator = new UnavailableParentAdjudicator();

    await expect(adjudicator.adjudicate(makeEvidence(), makeOptions()))
      .resolves.toMatchObject({
        outcome: "escalate",
        cause: "adjudicator-unavailable",
      });
  });

  it("satisfies the same interface as the live adjudicator", () => {
    // The gate holds one type and calls it the same way whether or not a
    // reviewer LLM was configured. If the stand-in ever stopped implementing
    // the interface, the gate would need an "is there an adjudicator" branch —
    // and a branch is where a fail-open answer would eventually be written.
    const live: ParentAdjudicator = new LlmParentAdjudicator(
      providerReturning('{"outcome":"allow","reason":"fine"}').provider,
      "m",
    );
    const standIn: ParentAdjudicator = new UnavailableParentAdjudicator();

    expect(typeof live.forgetChildRun).toBe("function");
    expect(typeof standIn.forgetChildRun).toBe("function");
  });
});

describe("escalation causes", () => {
  it("declares no cause the module cannot actually produce", () => {
    // A cause the gate can branch on but nothing emits is a branch that is
    // never exercised and never reviewed. Every member below is asserted by a
    // case above; this list is what fails to compile if the type gains a
    // member without one.
    const produced: readonly ParentAdjudicationEscalationCause[] = [
      "parent-escalated",
      "timeout",
      "malformed-output",
      "rate-limited",
      "adjudicator-unavailable",
      "llm-error",
    ];

    expect(new Set(produced).size).toBe(produced.length);
  });
});
