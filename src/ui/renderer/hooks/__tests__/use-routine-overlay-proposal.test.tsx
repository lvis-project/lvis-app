// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoutineOverlay } from "../use-routine-overlay.js";
import type { OverlayItem } from "../../context/OverlayContext.js";
import type { PluginOnboardingAction } from "../../../../plugins/public-contract.js";

/**
 * Answering an onboarding proposal from the renderer.
 *
 * The answer is recorded whichever way it went, and accepting performs the
 * DECLARED action and nothing else: text into a composer, or the settings view
 * onto a tab. A proposal must never travel the `imported_trigger` path the
 * insertion cards use, because nothing about it starts a turn.
 */
const TILE = "group-1";

function proposalItem(action: PluginOnboardingAction): OverlayItem {
  return {
    id: "proposal:meeting:first-task",
    source: { kind: "proposal", pluginId: "meeting", proposalId: "first-task", action },
    title: "Record this meeting?",
    summary: "Recording, transcript and summary, in one step.",
    running: false,
    primaryActionLabel: "Start recording",
    createdAt: new Date().toISOString(),
  };
}

function setup() {
  let showOverlay: ((item: OverlayItem) => void) | undefined;
  const answer = vi.fn(async () => ({ ok: true as const, pending: [] }));
  const api = {
    onRoutineRunningStarted: vi.fn(() => () => {}),
    onRoutineRunningFinished: vi.fn(() => () => {}),
    onRoutineFailed: vi.fn(() => () => {}),
    onRoutineFired: vi.fn(() => () => {}),
    listPendingRoutineResults: vi.fn(async () => []),
    acknowledgeRoutineResult: vi.fn(async () => undefined),
    onOverlayShow: vi.fn((handler: (item: OverlayItem) => void) => {
      showOverlay = handler;
      return () => {};
    }),
    onOverlayDismiss: vi.fn(() => () => {}),
    onboarding: { answer },
  };

  const prefillComposer = vi.fn();
  const ask = vi.fn();
  const insertImportedTriggerEntry = vi.fn();
  const registry = {
    read: vi.fn((id: string) =>
      id === TILE ? { prefillComposer, ask, insertImportedTriggerEntry } : undefined),
    readTiles: vi.fn(() => []),
  };
  const onNavigateToSettings = vi.fn();

  const hook = renderHook(() =>
    useRoutineOverlay({
      api: api as never,
      t: ((key: string) => key) as never,
      locale: "en",
      registry: registry as never,
      focusedChatGroupId: TILE,
      onNavigateToSettings,
    }));

  return {
    hook,
    answer,
    prefillComposer,
    ask,
    insertImportedTriggerEntry,
    onNavigateToSettings,
    show: (item: OverlayItem) => act(() => showOverlay?.(item)),
  };
}

describe("useRoutineOverlay — onboarding proposal answers", () => {
  it("prefills the card's tile composer on an accepted composer action", async () => {
    const s = setup();
    s.show(proposalItem({ kind: "composer", prompt: "Start recording the meeting" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "accepted",
        TILE,
      );
    });

    expect(s.prefillComposer).toHaveBeenCalledWith("Start recording the meeting");
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.insertImportedTriggerEntry).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith("meeting:first-task", "accepted", "en");
  });

  it("moves the settings view onto the named tab on an accepted settings action", async () => {
    const s = setup();
    s.show(proposalItem({ kind: "settings", path: "plugin-config" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "accepted",
        TILE,
      );
    });

    expect(s.onNavigateToSettings).toHaveBeenCalledWith("plugin-config");
    expect(s.prefillComposer).not.toHaveBeenCalled();
  });

  it("normalizes a settings tab the host has since renamed", async () => {
    const s = setup();
    s.show(proposalItem({ kind: "settings", path: "plugin-perf" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "accepted",
        TILE,
      );
    });

    expect(s.onNavigateToSettings).toHaveBeenCalledWith("plugin-config");
  });

  it.each(["later", "never"] as const)("records %s without performing the action", async (
    disposition,
  ) => {
    const s = setup();
    s.show(proposalItem({ kind: "composer", prompt: "Start recording the meeting" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        disposition,
        TILE,
      );
    });

    expect(s.prefillComposer).not.toHaveBeenCalled();
    expect(s.onNavigateToSettings).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith("meeting:first-task", disposition, "en");
  });

  it("does nothing for an accepted `none` action beyond recording the answer", async () => {
    const s = setup();
    s.show(proposalItem({ kind: "none" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "accepted",
        TILE,
      );
    });

    expect(s.prefillComposer).not.toHaveBeenCalled();
    expect(s.onNavigateToSettings).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith("meeting:first-task", "accepted", "en");
  });

  it("answers a proposal once — a second click has nothing left to report", async () => {
    const s = setup();
    s.show(proposalItem({ kind: "composer", prompt: "Start recording the meeting" }));

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "accepted",
        TILE,
      );
      await s.hook.result.current.handleProposalAnswer(
        "proposal:meeting:first-task",
        "never",
        TILE,
      );
    });

    expect(s.answer).toHaveBeenCalledTimes(1);
  });

  it("refuses to answer a card that is not a proposal", async () => {
    const s = setup();
    s.show({
      id: "plugin:meeting:evt",
      source: { kind: "plugin", pluginId: "meeting", eventId: "evt" },
      title: "Meeting",
      summary: "summary",
      running: false,
      pendingPrompt: "do the thing",
      createdAt: new Date().toISOString(),
    });

    await act(async () => {
      await s.hook.result.current.handleProposalAnswer("plugin:meeting:evt", "accepted", TILE);
    });

    expect(s.answer).not.toHaveBeenCalled();
    expect(s.prefillComposer).not.toHaveBeenCalled();
  });
});
