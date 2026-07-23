import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCardSummary } from "../../types.js";
import { PostTourFirstTask } from "../PostTourFirstTask.js";

function pluginCard(): PluginCardSummary {
  return {
    id: "sample-plugin",
    name: "Sample Plugin",
    description: "Synthetic plugin for onboarding tests.",
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded",
    active: true,
    runtimeLoaded: true,
    onboarding: {
      firstTask: {
        locales: {
          en: {
            headline: "Try the sample plugin",
            body: "This text comes from the manifest.",
            actionLabel: "Prefill",
            composerPrompt: "Help me use the sample plugin",
          },
        },
      },
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PostTourFirstTask", () => {
  it("prefills through the local callback without clipboard or auto-submit side effects", async () => {
    const onPrefillComposer = vi.fn();
    const clipboardWrite = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
    const view = render(
      <PostTourFirstTask
        onPrefillComposer={onPrefillComposer}
        pluginCards={[pluginCard()]}
        tourCompleted
      />,
    );

    fireEvent.click(await view.findByTestId("post-tour-first-task:accept"));

    await waitFor(() => {
      expect(onPrefillComposer).toHaveBeenCalledWith("Help me use the sample plugin");
    });
    expect(onPrefillComposer).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(view.queryByTestId("post-tour-first-task")).toBeNull();
    });
  });

  it("does not render before the tour completes or for an unusable card", () => {
    const onPrefillComposer = vi.fn();
    const view = render(
      <PostTourFirstTask
        onPrefillComposer={onPrefillComposer}
        pluginCards={[pluginCard()]}
        tourCompleted={false}
      />,
    );
    expect(view.queryByTestId("post-tour-first-task")).toBeNull();

    view.rerender(
      <PostTourFirstTask
        onPrefillComposer={onPrefillComposer}
        pluginCards={[{ ...pluginCard(), active: false }]}
        tourCompleted
      />,
    );
    expect(view.queryByTestId("post-tour-first-task")).toBeNull();
  });
});
