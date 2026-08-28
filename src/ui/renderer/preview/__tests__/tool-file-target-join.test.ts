/**
 * THE JOIN INVARIANT between the two renderer file-target derivations.
 *
 * `ChatView.routeActivity` resolves an ActionPanel row back against the chat
 * preview model by EXACT STRING EQUALITY:
 *
 *   previewModel.targets.find(c => "path" in c && c.path === target)
 *
 * where `target` is `computeActionPanelActivity(entries)`'s string and
 * `previewModel` is `collectChatPreviewModel({entries, attachments})`. The two
 * derivations are therefore not independent summaries — a string one side emits
 * and the other does not is by construction a lookup miss, and the click falls
 * to the dead-end `workspaceTabs.addTab("file-browser")` branch that opens an
 * unrelated file tree.
 *
 * These cases run BOTH REAL derivations over the SAME entries and assert the
 * invariant directly, rather than asserting each side's output in isolation
 * (which is how the two drifted apart while both sides' own tests stayed green).
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { collectChatPreviewModel } from "../preview-targets.js";
import { computeActionPanelActivity } from "../../utils/action-panel-activity.js";

/** The exact lookup ChatView.routeActivity performs for a non-web row. */
function resolvesInPreview(model: ReturnType<typeof collectChatPreviewModel>, target: string): boolean {
  return model.targets.some((candidate) => "path" in candidate && candidate.path === target);
}

/** Every file target the ActionPanel would render as a clickable row. */
function actionPanelFileTargets(entries: ChatEntry[]): string[] {
  const activity = computeActionPanelActivity(entries);
  return [...activity.readFiles, ...activity.writtenFiles]
    .map((item) => item.target)
    .filter((target): target is string => typeof target === "string");
}

function toolGroup(tools: Array<Record<string, unknown>>): ChatEntry {
  return {
    kind: "tool_group",
    groupId: "g1",
    groupIds: ["g1"],
    status: "done",
    tools: tools as never,
  } as ChatEntry;
}

/** Assert the invariant, and that the case is non-vacuous (it produced rows). */
function expectJoinHolds(entries: ChatEntry[], expectedTargets: string[]) {
  const model = collectChatPreviewModel({ entries, attachments: [] });
  const targets = actionPanelFileTargets(entries);
  expect([...new Set(targets)].sort()).toEqual([...expectedTargets].sort());
  for (const target of targets) {
    expect({ target, resolves: resolvesInPreview(model, target) })
      .toEqual({ target, resolves: true });
  }
}

describe("action panel <-> preview file-target join", () => {
  it("holds for a plain read_file", () => {
    expectJoinHolds(
      [toolGroup([{
        toolUseId: "read-1",
        name: "read_file",
        displayOrder: 0,
        status: "done",
        category: "read",
        input: { path: "C:\\workspace\\report.md" },
        result: "# Report",
      }])],
      ["C:\\workspace\\report.md"],
    );
  });

  it("holds for apply_patch — the patched paths live only in the patch body", () => {
    // Divergence (2) in the survey: the action panel extracted these paths and
    // the preview side did not, so every apply_patch row dead-ended.
    expectJoinHolds(
      [toolGroup([{
        toolUseId: "patch-1",
        name: "apply_patch",
        displayOrder: 0,
        status: "done",
        category: "write",
        input: {
          patch: [
            "*** Update File: src/app/main.ts",
            "*** Add File: src/app/new.ts",
          ].join("\n"),
        },
        result: "ok",
      }])],
      ["src/app/main.ts", "src/app/new.ts"],
    );
  });

  it("holds for glob_files — a glob is an argument, so NEITHER side emits it", () => {
    // Divergence (1): the action panel rendered `src/**/*.ts` as a touched file
    // and the preview side never did, so that row dead-ended too. The rule the
    // preview side already had (stricter) is the one adopted.
    const entries = [toolGroup([{
      toolUseId: "glob-1",
      name: "glob_files",
      displayOrder: 0,
      status: "done",
      category: "read",
      input: { path: "src/**/*.ts" },
      result: "{}",
    }])];

    expect(actionPanelFileTargets(entries)).toEqual([]);
    expect(resolvesInPreview(collectChatPreviewModel({ entries, attachments: [] }), "src/**/*.ts"))
      .toBe(false);
  });

  it("holds for a mixed transcript of all three tool shapes at once", () => {
    expectJoinHolds(
      [toolGroup([
        {
          toolUseId: "read-2",
          name: "read_file",
          displayOrder: 0,
          status: "done",
          category: "read",
          input: { path: "docs/design.md" },
          result: "x",
        },
        {
          toolUseId: "glob-2",
          name: "glob_files",
          displayOrder: 1,
          status: "done",
          category: "read",
          input: { path: "docs/**" },
          result: "{}",
        },
        {
          toolUseId: "patch-2",
          name: "apply_patch",
          displayOrder: 2,
          status: "done",
          category: "write",
          input: { patch: "*** Delete File: docs/old.md" },
          result: "ok",
        },
      ])],
      ["docs/design.md", "docs/old.md"],
    );
  });
});

/** Every fetched page the ActionPanel would render as a clickable row. */
function actionPanelWebTargets(entries: ChatEntry[]): string[] {
  return computeActionPanelActivity(entries)
    .fetchedPages.map((item) => item.target)
    .filter((target): target is string => typeof target === "string");
}

/** Every page the side panel's Browser tab would list (`BROWSER_TARGET_KINDS`). */
function browserTabUrls(entries: ChatEntry[]): string[] {
  return collectChatPreviewModel({ entries, attachments: [] })
    .targets.filter((target) => target.kind === "url")
    .map((target) => target.url);
}

/**
 * The same invariant on the WEB axis. The Browser tab and the Tool Activity
 * page list are two views of one set of fetched pages, so a page one side names
 * and the other does not is the "no web artifacts" panel sitting next to an
 * activity popup listing dozens of sources.
 */
describe("action panel <-> preview web-target join", () => {
  it("lists a search's result URLs on both sides, once each", () => {
    const entries = [toolGroup([
      {
        toolUseId: "search-1",
        name: "web_search",
        displayOrder: 0,
        status: "done",
        category: "network",
        input: { query: "lvis" },
        // A search names its hits ONLY in the result — the arguments carry a
        // query string and nothing else.
        result: JSON.stringify({
          results: [
            { url: "https://a.example/one", title: "One" },
            { url: "https://b.example/two", title: "Two" },
          ],
        }),
      },
      {
        toolUseId: "fetch-1",
        name: "web_fetch",
        displayOrder: 1,
        status: "done",
        category: "network",
        // The follow-up fetch of a page the search already surfaced is the
        // same artifact, not a second one.
        input: { url: "https://a.example/one" },
        result: "<html></html>",
      },
    ])];

    const expected = ["https://a.example/one", "https://b.example/two"];
    expect([...new Set(actionPanelWebTargets(entries))].sort()).toEqual(expected);
    expect(browserTabUrls(entries).sort()).toEqual(expected);
  });

  it("neither side promotes a URL quoted inside a file a read tool returned", () => {
    const entries = [toolGroup([
      {
        toolUseId: "read-1",
        name: "read_file",
        displayOrder: 0,
        status: "done",
        category: "read",
        input: { path: "/docs/links.md" },
        result: "see https://quoted.example/page for details",
      },
    ])];

    expect(actionPanelWebTargets(entries)).toEqual([]);
    expect(browserTabUrls(entries)).toEqual([]);
  });
});
