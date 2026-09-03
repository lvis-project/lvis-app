/**
 * `lvis:onboarding:proposals:*` — the host side of plugin onboarding proposals.
 *
 * What these channels have to get right is the sequencing, so that is what is
 * proved here:
 *   - the sender frame is checked before anything is read or written
 *   - asking what is pending STAGES the head of the queue as an overlay card,
 *     one at a time, on the ordinary `OVERLAY_V1.show` path
 *   - an answer is persisted and the NEXT proposal is staged from state that
 *     already contains it — so the same launch never re-asks
 *   - a malformed key or disposition writes nothing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent, foreignFrameEvent } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { readOnboardingProposalState } from "../../../main/onboarding-proposal-store.js";
import type { PluginOnboardingSpec } from "../../../plugins/public-contract.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const meetingOnboarding: PluginOnboardingSpec = {
  firstTask: {
    priority: 10,
    locales: {
      en: {
        headline: "Record this meeting?",
        body: "Recording, transcript and summary, in one step.",
        actionLabel: "Start recording",
        composerPrompt: "Start recording the meeting",
      },
    },
  },
  highlights: [
    {
      id: "share-summary",
      copy: {
        en: {
          headline: "Share a summary",
          body: "Send the summary where the team reads it.",
          actionLabel: "Show me how",
        },
      },
      action: { kind: "settings", path: "plugin-config" },
    },
  ],
};

let tempDir: string;
let prevLvisHome: string | undefined;

async function setup(cards?: unknown[]) {
  handlers.clear();
  vi.clearAllMocks();
  const send = vi.fn();
  const deps = {
    auditLogger: { log: vi.fn() },
    pluginRuntime: {
      listPluginCards: vi.fn(() =>
        cards ?? [
          { id: "meeting", loadStatus: "loaded", active: true, onboarding: meetingOnboarding },
        ]),
    },
    toolRegistry: { size: 0 },
    getMainWindow: vi.fn(() => null),
  };
  const { registerTourHandlers } = await import("../tour.js");
  registerTourHandlers(deps as never);
  const event = { ...hostFrameEvent(), sender: { isDestroyed: () => false, send } };
  return { deps, send, event };
}

/** The overlay cards pushed to the renderer that asked. */
function stagedCards(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .filter(([channel]) => channel === OVERLAY_V1.show)
    .map(([, item]) => item as { id: string; source: { proposalId: string } });
}

beforeEach(() => {
  prevLvisHome = process.env.LVIS_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "lvis-onboarding-ipc-"));
  process.env.LVIS_HOME = tempDir;
});

afterEach(async () => {
  if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevLvisHome;
  await cleanupTmpDir(tempDir);
});

describe("lvis:onboarding:proposals:list-pending", () => {
  it("rejects an unauthorized sender frame before reading anything", async () => {
    const { send } = await setup();
    const result = await handlers.get(CHANNELS.onboarding.listPending)!(
      foreignFrameEvent("https://evil.example.com/x") as never,
      { locale: "en" },
    );
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(stagedCards(send)).toHaveLength(0);
  });

  it("stages only the head of the queue, as a plugin overlay card", async () => {
    const { send, event } = await setup();
    const result = (await handlers.get(CHANNELS.onboarding.listPending)!(
      event as never,
      { locale: "en" },
    )) as { ok: true; pending: Array<{ key: string }> };

    expect(result.ok).toBe(true);
    expect(result.pending.map((p) => p.key)).toEqual([
      "meeting:first-task",
      "meeting:share-summary",
    ]);

    const staged = stagedCards(send);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      id: "proposal:meeting:first-task",
      title: "Record this meeting?",
      summary: "Recording, transcript and summary, in one step.",
      running: false,
      primaryActionLabel: "Start recording",
      source: {
        kind: "proposal",
        pluginId: "meeting",
        proposalId: "first-task",
        action: { kind: "composer", prompt: "Start recording the meeting" },
      },
    });
  });

  it("ignores a plugin that is not loaded and active", async () => {
    const { send, event } = await setup([
      { id: "meeting", loadStatus: "failed", active: true, onboarding: meetingOnboarding },
      { id: "indexer", loadStatus: "loaded", active: false, onboarding: meetingOnboarding },
      { id: "quiet", loadStatus: "loaded", active: true },
    ]);
    const result = (await handlers.get(CHANNELS.onboarding.listPending)!(
      event as never,
      { locale: "en" },
    )) as { ok: true; pending: unknown[] };

    expect(result.pending).toEqual([]);
    expect(stagedCards(send)).toHaveLength(0);
  });
});

describe("lvis:onboarding:proposals:answer", () => {
  it("rejects an unauthorized sender frame before writing anything", async () => {
    await setup();
    const result = await handlers.get(CHANNELS.onboarding.answer)!(
      foreignFrameEvent("https://evil.example.com/x") as never,
      { key: "meeting:first-task", disposition: "never", locale: "en" },
    );
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect((await readOnboardingProposalState()).answers).toEqual({});
  });

  it.each([
    ["a key that is not <pluginId>:<proposalId>", { key: "meeting", disposition: "later" }],
    ["a key with a path separator", { key: "meeting:../escape", disposition: "later" }],
    ["an unknown disposition", { key: "meeting:first-task", disposition: "snoozed" }],
    ["a missing disposition", { key: "meeting:first-task" }],
  ])("writes nothing for %s", async (_name, payload) => {
    const { event } = await setup();
    const result = (await handlers.get(CHANNELS.onboarding.answer)!(
      event as never,
      payload,
    )) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect((await readOnboardingProposalState()).answers).toEqual({});
  });

  it("persists the answer and stages the next proposal", async () => {
    const { send, event } = await setup();
    await handlers.get(CHANNELS.onboarding.listPending)!(event as never, { locale: "en" });
    send.mockClear();

    const result = (await handlers.get(CHANNELS.onboarding.answer)!(event as never, {
      key: "meeting:first-task",
      disposition: "accepted",
      locale: "en",
    })) as { ok: true; pending: Array<{ key: string }> };

    expect(result.pending.map((p) => p.key)).toEqual(["meeting:share-summary"]);
    expect((await readOnboardingProposalState()).answers["meeting:first-task"].disposition)
      .toBe("accepted");

    const staged = stagedCards(send);
    expect(staged).toHaveLength(1);
    expect(staged[0].source.proposalId).toBe("share-summary");
  });

  it("does not re-ask a `later` answer within the same launch", async () => {
    const { send, event } = await setup();
    await handlers.get(CHANNELS.onboarding.answer)!(event as never, {
      key: "meeting:first-task",
      disposition: "later",
      locale: "en",
    });
    send.mockClear();

    const result = (await handlers.get(CHANNELS.onboarding.listPending)!(
      event as never,
      { locale: "en" },
    )) as { ok: true; pending: Array<{ key: string }> };

    expect(result.pending.map((p) => p.key)).toEqual(["meeting:share-summary"]);
    expect(stagedCards(send)[0].source.proposalId).toBe("share-summary");
  });

  it("asks a `later` answer again on the next launch", async () => {
    const first = await setup();
    await handlers.get(CHANNELS.onboarding.answer)!(first.event as never, {
      key: "meeting:first-task",
      disposition: "later",
      locale: "en",
    });

    // Registering again is a new launch: the stored answer survives, the
    // per-launch set does not.
    const next = await setup();
    const result = (await handlers.get(CHANNELS.onboarding.listPending)!(
      next.event as never,
      { locale: "en" },
    )) as { ok: true; pending: Array<{ key: string }> };

    expect(result.pending[0].key).toBe("meeting:first-task");
    expect(stagedCards(next.send)[0].source.proposalId).toBe("first-task");
  });
});
