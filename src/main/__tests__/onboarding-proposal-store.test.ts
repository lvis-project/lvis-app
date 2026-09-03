import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FIRST_TASK_PROPOSAL_ID,
  onboardingProposalKey,
  pendingOnboardingProposals,
  readOnboardingProposalState,
  recordOnboardingProposalAnswer,
  type OnboardingProposalSource,
} from "../onboarding-proposal-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

/**
 * `~/.lvis/onboarding/proposals.json` — the answers, and the selection that
 * reads them.
 *
 * The behaviours worth pinning are the three answers pulling in different
 * directions: `accepted` and `never` end the proposal, `later` ends it only
 * for the launch it was given in, and the launch boundary is a set the caller
 * owns rather than a timestamp comparison.
 */
describe("onboarding-proposal-store", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-onboarding-proposals-"));
    process.env.LVIS_HOME = tempDir;
  });

  afterEach(async () => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    await cleanupTmpDir(tempDir);
  });

  const proposalsPath = () => join(tempDir, "onboarding", "proposals.json");

  it("starts empty and persists an answer under the feature namespace", async () => {
    expect(await readOnboardingProposalState()).toEqual({ answers: {} });

    await recordOnboardingProposalAnswer("meeting:first-task", "later");

    const onDisk = JSON.parse(readFileSync(proposalsPath(), "utf-8")) as {
      answers: Record<string, { disposition: string; answeredAt: string }>;
    };
    expect(onDisk.answers["meeting:first-task"].disposition).toBe("later");
    expect(Date.parse(onDisk.answers["meeting:first-task"].answeredAt)).not.toBeNaN();
    expect((await readOnboardingProposalState()).answers["meeting:first-task"].disposition)
      .toBe("later");
  });

  it("replaces a previous answer for the same key", async () => {
    await recordOnboardingProposalAnswer("meeting:first-task", "later");
    await recordOnboardingProposalAnswer("meeting:first-task", "never");

    const state = await readOnboardingProposalState();
    expect(Object.keys(state.answers)).toEqual(["meeting:first-task"]);
    expect(state.answers["meeting:first-task"].disposition).toBe("never");
  });

  it("drops entries whose disposition or timestamp is not readable", async () => {
    mkdirSync(join(tempDir, "onboarding"), { recursive: true });
    writeFileSync(
      proposalsPath(),
      JSON.stringify({
        answers: {
          "a:one": { disposition: "snoozed", answeredAt: "2026-01-01T00:00:00.000Z" },
          "b:two": { disposition: "never" },
          "c:three": { disposition: "accepted", answeredAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
      "utf-8",
    );
    const state = await readOnboardingProposalState();
    expect(Object.keys(state.answers)).toEqual(["c:three"]);
  });

  it("returns the empty state for a corrupt file rather than throwing", async () => {
    await recordOnboardingProposalAnswer("meeting:first-task", "never");
    writeFileSync(proposalsPath(), "{ not json", "utf-8");
    expect(await readOnboardingProposalState()).toEqual({ answers: {} });
  });

  describe("pendingOnboardingProposals", () => {
    const meeting: OnboardingProposalSource = {
      pluginId: "meeting",
      onboarding: {
        firstTask: {
          priority: 10,
          locales: {
            en: {
              headline: "Record this meeting?",
              body: "Recording, transcript and summary, in one step.",
              actionLabel: "Start recording",
              composerPrompt: "Start recording the meeting",
            },
            ko: {
              headline: "지금 회의를 녹음할까요?",
              body: "녹음, 전사, 요약을 한 번에 처리합니다.",
              actionLabel: "녹음 시작",
              composerPrompt: "회의 녹음을 시작해줘",
            },
          },
        },
        highlights: [
          {
            id: "share-summary",
            priority: 20,
            copy: {
              en: {
                headline: "Share a summary",
                body: "Send the summary where the team reads it.",
                actionLabel: "Show me how",
              },
            },
            action: { kind: "composer", prompt: "Share the last meeting summary" },
          },
          {
            id: "pick-a-microphone",
            copy: {
              en: {
                headline: "Choose a microphone",
                body: "Pick the input device once.",
                actionLabel: "Open settings",
              },
            },
            action: { kind: "settings", path: "plugin-config" },
          },
        ],
      },
    };

    const indexer: OnboardingProposalSource = {
      pluginId: "local-indexer",
      onboarding: {
        firstTask: {
          priority: 5,
          locales: {
            en: {
              headline: "Index a folder?",
              body: "Point at one folder and search it in plain language.",
              actionLabel: "Choose a folder",
              composerPrompt: "Add a folder to index",
            },
          },
        },
      },
    };

    const empty = { answers: {} };

    it("puts every firstTask before any highlight, then orders by priority", () => {
      const pending = pendingOnboardingProposals(
        [meeting, indexer],
        empty,
        new Set(),
        "en",
      );
      expect(pending.map((p) => p.key)).toEqual([
        "local-indexer:first-task",
        "meeting:first-task",
        "meeting:share-summary",
        "meeting:pick-a-microphone",
      ]);
    });

    it("resolves copy for the requested locale and falls back to English", () => {
      const [firstTask] = pendingOnboardingProposals([meeting], empty, new Set(), "ko-KR");
      expect(firstTask.headline).toBe("지금 회의를 녹음할까요?");
      expect(firstTask.action).toEqual({
        kind: "composer",
        prompt: "회의 녹음을 시작해줘",
      });

      const [englishFallback] = pendingOnboardingProposals([meeting], empty, new Set(), "fr");
      expect(englishFallback.headline).toBe("Record this meeting?");
    });

    it("carries the declared action through unchanged", () => {
      const pending = pendingOnboardingProposals([meeting], empty, new Set(), "en");
      expect(pending.find((p) => p.proposalId === "pick-a-microphone")?.action).toEqual({
        kind: "settings",
        path: "plugin-config",
      });
    });

    it("drops proposals answered accepted or never, permanently", () => {
      const state = {
        answers: {
          [onboardingProposalKey("meeting", FIRST_TASK_PROPOSAL_ID)]: {
            disposition: "accepted" as const,
            answeredAt: "2026-01-01T00:00:00.000Z",
          },
          "meeting:share-summary": {
            disposition: "never" as const,
            answeredAt: "2026-01-01T00:00:00.000Z",
          },
        },
      };
      const pending = pendingOnboardingProposals([meeting], state, new Set(), "en");
      expect(pending.map((p) => p.key)).toEqual(["meeting:pick-a-microphone"]);
    });

    it("re-arms a `later` answer on the next launch, but not within one", () => {
      const state = {
        answers: {
          "meeting:first-task": {
            disposition: "later" as const,
            answeredAt: "2026-01-01T00:00:00.000Z",
          },
        },
      };

      // Same launch as the answer: the set the caller carries suppresses it.
      const sameLaunch = pendingOnboardingProposals(
        [meeting],
        state,
        new Set(["meeting:first-task"]),
        "en",
      );
      expect(sameLaunch.map((p) => p.key)).not.toContain("meeting:first-task");

      // A new launch starts with an empty set, and the stored `later` is not
      // terminal, so the question comes back.
      const nextLaunch = pendingOnboardingProposals([meeting], state, new Set(), "en");
      expect(nextLaunch[0].key).toBe("meeting:first-task");
    });

    it("skips a plugin that declares no onboarding copy for any locale", () => {
      const copyless: OnboardingProposalSource = {
        pluginId: "quiet",
        onboarding: { highlights: [] },
      };
      expect(pendingOnboardingProposals([copyless], empty, new Set(), "en")).toEqual([]);
    });
  });
});
