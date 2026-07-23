import { describe, expect, it } from "vitest";
import type { PluginCardSummary } from "../../types.js";
import { pickFirstTaskProposal } from "../first-task-proposals.js";

function card(
  id: string,
  priority: number | undefined = 100,
  overrides: Partial<PluginCardSummary> = {},
): PluginCardSummary {
  return {
    id,
    name: id,
    description: `${id} description`,
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded",
    active: true,
    runtimeLoaded: true,
    onboarding: {
      firstTask: {
        ...(priority === undefined ? {} : { priority }),
        locales: {
          en: {
            headline: `${id} headline`,
            body: `${id} body`,
            actionLabel: `${id} action`,
            composerPrompt: `${id} prompt`,
          },
          ko: {
            headline: `${id} 제목`,
            body: `${id} 본문`,
            actionLabel: `${id} 실행`,
            composerPrompt: `${id} 요청`,
          },
        },
      },
    },
    ...overrides,
  };
}

describe("pickFirstTaskProposal", () => {
  it("selects the lowest priority independent of card order", () => {
    expect(pickFirstTaskProposal([card("sample-beta", 20), card("sample-alpha", 10)], "en")?.pluginId)
      .toBe("sample-alpha");
  });

  it("breaks equal-priority ties deterministically by plugin id", () => {
    expect(pickFirstTaskProposal([card("sample-zulu", 10), card("sample-alpha", 10)], "en")?.pluginId)
      .toBe("sample-alpha");
  });

  it("uses priority 100 when the declaration omits priority", () => {
    expect(pickFirstTaskProposal([card("sample-default", undefined)], "en")?.priority).toBe(100);
  });

  it.each([
    { loadStatus: "disabled" as const, active: true },
    { loadStatus: "failed" as const, active: true },
    { loadStatus: "preparing" as const, active: true },
    { loadStatus: "loaded" as const, active: false },
  ])("ignores unusable plugin cards: %o", (state) => {
    expect(pickFirstTaskProposal([card("sample-plugin", 10, state)], "en")).toBeNull();
  });

  it("ignores cards without a declarative first task", () => {
    expect(pickFirstTaskProposal([card("sample-plugin", 10, { onboarding: undefined })], "en")).toBeNull();
  });

  it("uses exact locale, then primary language, then English", () => {
    const plugin = card("sample-plugin", 10);
    expect(pickFirstTaskProposal([plugin], "ko")?.headline).toBe("sample-plugin 제목");
    expect(pickFirstTaskProposal([plugin], "ko-KR")?.headline).toBe("sample-plugin 제목");
    expect(pickFirstTaskProposal([plugin], "fr-FR")?.headline).toBe("sample-plugin headline");
  });

  it("returns null for an empty card set", () => {
    expect(pickFirstTaskProposal([], "en")).toBeNull();
  });
});
