import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n/react.js";
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
        priority: 10,
        locales: {
          en: {
            headline: "Try the sample plugin",
            body: "This text comes from the manifest.",
            actionLabel: "Prefill",
            composerPrompt: "Help me use the sample plugin",
          },
          ko: {
            headline: "샘플 플러그인 사용해 보기",
            body: "이 문구는 매니페스트에서 제공됩니다.",
            actionLabel: "채우기",
            composerPrompt: "샘플 플러그인 사용법을 알려줘",
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
      <I18nProvider locale="en" setLocale={vi.fn()}>
        <PostTourFirstTask
          onPrefillComposer={onPrefillComposer}
          pluginCards={[pluginCard()]}
          tourCompleted
        />
      </I18nProvider>,
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
    const renderCard = (card: PluginCardSummary, tourCompleted: boolean) => (
      <I18nProvider locale="en" setLocale={vi.fn()}>
        <PostTourFirstTask
          onPrefillComposer={onPrefillComposer}
          pluginCards={[card]}
          tourCompleted={tourCompleted}
        />
      </I18nProvider>
    );
    const view = render(
      renderCard(pluginCard(), false),
    );
    expect(view.queryByTestId("post-tour-first-task")).toBeNull();

    view.rerender(renderCard({ ...pluginCard(), active: false }, true));
    expect(view.queryByTestId("post-tour-first-task")).toBeNull();
  });

  it("updates visible copy and composer prefill when the active locale changes", async () => {
    const onPrefillComposer = vi.fn();
    const renderCard = (locale: "en" | "ko") => (
      <I18nProvider locale={locale} setLocale={vi.fn()}>
        <PostTourFirstTask
          onPrefillComposer={onPrefillComposer}
          pluginCards={[pluginCard()]}
          tourCompleted
        />
      </I18nProvider>
    );
    const view = render(renderCard("en"));
    expect(view.getByText("Try the sample plugin")).toBeTruthy();

    view.rerender(renderCard("ko"));
    expect(view.getByText("샘플 플러그인 사용해 보기")).toBeTruthy();
    fireEvent.click(view.getByTestId("post-tour-first-task:accept"));

    await waitFor(() => {
      expect(onPrefillComposer).toHaveBeenCalledWith("샘플 플러그인 사용법을 알려줘");
    });
  });
});
