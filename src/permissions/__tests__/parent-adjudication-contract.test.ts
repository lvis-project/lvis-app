/**
 * Tier-2 (parent-adjudication) contract surface — the types, settings, and
 * host-only request fields the lane is built on, before any lane exists.
 *
 * Nothing here exercises an adjudication: the stage that consumes these lands
 * separately. What these pin is the shape it will be handed, and the two
 * properties that a later stage must not be able to weaken:
 *
 *   (a) the verdict ceiling cannot be raised to "high" by any settings file;
 *   (b) the host-only request fields never reach the renderer.
 *
 * (b) is worth a test while the fields have no reader precisely because that
 * is when the leak would be invisible — the fields are removed from the
 * renderer payload by a destructuring that no failing behaviour would flag.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPermissionSettings } from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";
import { ApprovalGate, approvalAnswererAuditToken } from "../approval-gate.js";
import type {
  ApprovalRequest,
  ApprovalRequestInput,
} from "../approval-gate.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { normalizeFeatureFlags } from "../../data/settings-normalization.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

function writeSettings(dir: string, reviewer: object): string {
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ permissions: { reviewer } }, null, 2), {
    mode: 0o600,
  });
  return p;
}

const BASE_REVIEWER = {
  mode: "llm",
  provider: "openai",
  model: "gpt-4o-mini",
  fallbackOnError: "deny",
  interactive: { autoApprove: "medium" },
};

describe("reviewer.parentAdjudication settings block", () => {
  it("defaults to the shipped tier-2 policy when the file omits the block", () => {
    const dir = resources.makeTmpDir("lvis-parent-adj-");
    const p = writeSettings(dir, BASE_REVIEWER);

    expect(readPermissionSettings(p).permissions.reviewer.parentAdjudication)
      .toEqual({
        maxVerdict: "medium",
        timeoutMs: 30_000,
        maxPerChildRun: 200,
        includeParentContextTurns: 0,
        backgroundEscalation: "deferred",
        model: "reviewer",
      });
  });

  it("reads a well-formed block verbatim", () => {
    const dir = resources.makeTmpDir("lvis-parent-adj-");
    const p = writeSettings(dir, {
      ...BASE_REVIEWER,
      parentAdjudication: {
        maxVerdict: "low",
        timeoutMs: 5_000,
        maxPerChildRun: 12,
      },
    });

    expect(readPermissionSettings(p).permissions.reviewer.parentAdjudication)
      .toEqual({
        maxVerdict: "low",
        timeoutMs: 5_000,
        maxPerChildRun: 12,
        includeParentContextTurns: 0,
        backgroundEscalation: "deferred",
        model: "reviewer",
      });
  });

  it("refuses to raise the ceiling to high, however the file spells it", () => {
    const dir = resources.makeTmpDir("lvis-parent-adj-");
    // A hand-edited file is the whole threat model for this field: HIGH is the
    // band the user reserved for themselves, and no on-disk value may hand it
    // to an agent. Both a plausible spelling and a nonsense one land on the
    // shipped default rather than anywhere wider.
    for (const maxVerdict of ["high", "HIGH", "critical", 3, null]) {
      const p = writeSettings(dir, {
        ...BASE_REVIEWER,
        parentAdjudication: { maxVerdict },
      });
      expect(
        readPermissionSettings(p).permissions.reviewer.parentAdjudication
          .maxVerdict,
      ).toBe("medium");
    }
  });

  it("clamps out-of-range numbers instead of honouring them", () => {
    const dir = resources.makeTmpDir("lvis-parent-adj-");
    const p = writeSettings(dir, {
      ...BASE_REVIEWER,
      parentAdjudication: {
        maxVerdict: "medium",
        timeoutMs: 60 * 60 * 1000,
        maxPerChildRun: 10_000,
      },
    });

    const block = readPermissionSettings(p).permissions.reviewer.parentAdjudication;
    expect(block.timeoutMs).toBe(120_000);
    expect(block.maxPerChildRun).toBe(1_000);
  });

  it("falls back for values that have no clamped meaning", () => {
    const dir = resources.makeTmpDir("lvis-parent-adj-");
    const p = writeSettings(dir, {
      ...BASE_REVIEWER,
      parentAdjudication: {
        maxVerdict: "medium",
        timeoutMs: "30s",
        maxPerChildRun: Number.NaN,
      },
    });

    const block = readPermissionSettings(p).permissions.reviewer.parentAdjudication;
    expect(block.timeoutMs).toBe(30_000);
    expect(block.maxPerChildRun).toBe(200);
  });
});

describe("features.subAgentParentAdjudication", () => {
  it("ships on", () => {
    expect(DEFAULT_SETTINGS.features?.subAgentParentAdjudication).toBe(true);
  });

  it("is normalized only from a boolean", () => {
    expect(
      normalizeFeatureFlags({ subAgentParentAdjudication: false })
        .subAgentParentAdjudication,
    ).toBe(false);
    expect(
      normalizeFeatureFlags({ subAgentParentAdjudication: "true" })
        .subAgentParentAdjudication,
    ).toBeUndefined();
  });
});

describe("parent-agent answerer", () => {
  it("has an audit token of its own", () => {
    // The point of the answerer dimension is that a reviewer can tell who
    // decided a call. A parent answer rendering as `desk` would erase exactly
    // the fact the row exists to record.
    expect(approvalAnswererAuditToken("parent-agent")).toBe("parent-agent");
    expect(approvalAnswererAuditToken("desk")).toBe("desk");
  });
});

describe("host-only child provenance fields", () => {
  function makeGate() {
    const wc = {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    };
    return { wc, gate: new ApprovalGate(wc as never) };
  }

  function makeRequest(): ApprovalRequestInput {
    return {
      id: "child-req-1",
      category: "tool",
      toolName: "fs_write",
      args: { path: "/tmp/note.md", content: "hi" },
      reason: "[Sub-Agent: docs sweep] 상태 변경 도구",
      source: "builtin",
      createdAt: Date.now(),
      sessionId: "conv-parent",
      childProvenance: {
        childSessionId: "conv-child",
        childTitle: "docs sweep",
        originSessionId: "conv-parent",
        spawnTaskSummary: "Update the changelog for the docs sweep.",
      },
      parentAdjudicationEligible: true,
    };
  }

  it("never sends child provenance or eligibility to the renderer", async () => {
    const { wc, gate } = makeGate();

    const promise = gate.requestAndWait(makeRequest());

    const [, sent] = wc.send.mock.calls[0] as unknown as [
      string,
      ApprovalRequest,
    ];
    expect(sent.id).toBe("child-req-1");
    expect(sent).not.toHaveProperty("childProvenance");
    expect(sent).not.toHaveProperty("parentAdjudicationEligible");
    // Nothing about the child leaks through a nested value either: the
    // renderer must not be able to reconstruct which conversation is blocked.
    expect(JSON.stringify(sent)).not.toContain("conv-child");

    gate.disposeAll();
    await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
  });

  it("still asks the renderer — the fields decide nothing on their own", async () => {
    const { wc, gate } = makeGate();

    // `parentAdjudicationEligible` is a caller assertion, not an authority.
    // Until a stage reads it, an eligible request behaves exactly like any
    // other ask, which is what makes the flag-off path byte-identical.
    const promise = gate.requestAndWait(makeRequest());
    expect(wc.send).toHaveBeenCalledTimes(1);

    gate.disposeAll();
    await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
  });
});
