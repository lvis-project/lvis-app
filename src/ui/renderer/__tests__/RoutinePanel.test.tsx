/**
 * Q12 P5 round 2 — RoutinePanel button label / payload mapping lock.
 *
 * Asserts the contract surfaced by the panel: when the user clicks the
 * "선택 해제 (플러그인 사용 안 함)" button or leaves the plugin list empty,
 * the resulting `addRoutineV2` payload uses `{ mode: "deny-all" }` per
 * spec §3 Layer 4 (RoutinePluginScope discriminated union). Catches the
 * Copilot round-2 finding: previous label said "전체 허용" but the actual
 * semantic is deny-all — copy and behavior must agree.
 */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { AddRoutineModal } from "../components/RoutinePanel.js";
import type { LvisApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, RoutineRecord } from "../../../shared/routines-types.js";

function makeStubApi(opts: {
  pluginCards?: PluginCardSummary[];
  addRoutineV2: ReturnType<typeof vi.fn>;
}): LvisApi {
  const cards = opts.pluginCards ?? [];
  return {
    listPluginCards: vi.fn().mockResolvedValue(cards),
    addRoutineV2: opts.addRoutineV2,
  } as unknown as LvisApi;
}

function makeRoutineRecord(): RoutineRecord {
  return {
    id: "rt-1",
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "test",
    title: "test",
    schedule: { at: new Date().toISOString(), repeat: { kind: "none" } },
    scope: { pluginIds: { mode: "deny-all" }, forcedPluginIds: [], directories: [] },
    createdAt: new Date().toISOString(),
    state: "active",
    firedAt: null,
    dismissedAt: null,
  } as unknown as RoutineRecord;
}

function validFutureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("Q12 P5 round 2 — RoutinePanel scope payload mapping", () => {
  it("empty plugin selection submits scope.pluginIds = { mode: 'deny-all' }", async () => {
    const addRoutineV2 = vi.fn().mockResolvedValue({ ok: true, routine: makeRoutineRecord() });
    const api = makeStubApi({
      pluginCards: [
        {
          id: "plugin-a",
          name: "Plugin A",
          description: "",
          sampleTools: [],
          capabilities: [],
          tools: ["tool_a"],
          loadStatus: "loaded",
        },
      ],
      addRoutineV2,
    });
    const onClose = vi.fn();
    const onAdded = vi.fn();

    const { getByTestId, getByText } = render(
      <AddRoutineModal api={api} onClose={onClose} onAdded={onAdded} />,
    );

    // Wait for plugin cards to load.
    await waitFor(() => {
      getByTestId("routine-allowed-plugin-plugin-a");
    });

    // Provide minimal valid form input: prePrompt + atDate.
    fireEvent.change(getByTestId("pre-prompt-input"), { target: { value: "do thing" } });
    // The form tab needs at least an `atDate`. Pick a date input.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThan(0);
    fireEvent.change(dateInputs[0]!, { target: { value: validFutureDate() } });

    // Toggle plugin on then off — exercising the click path. Final state empty.
    const checkbox = getByTestId("routine-allowed-plugin-plugin-a") as HTMLInputElement;
    fireEvent.click(checkbox); // selected
    expect(checkbox.checked).toBe(true);

    // Click the "선택 해제 (플러그인 사용 안 함)" button — clears selection.
    const clearBtn = getByTestId("routine-clear-allowed-plugins");
    expect(clearBtn.textContent).toContain("플러그인 사용 안 함");
    fireEvent.click(clearBtn);

    // Submit. The "등록" button is the second one in the modal (first is 취소).
    const registerBtn = getByText("등록") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(registerBtn);
    });

    await waitFor(() => {
      expect(addRoutineV2).toHaveBeenCalledTimes(1);
    });
    const payload = addRoutineV2.mock.calls[0]![0] as AddRoutineInput;
    expect(payload.scope).toBeDefined();
    expect(payload.scope?.pluginIds).toEqual({ mode: "deny-all" });
    // Sanity: forcedPluginIds + directories defaults preserved.
    expect(payload.scope?.forcedPluginIds).toEqual([]);
    expect(payload.scope?.directories).toEqual([]);
  });

  it("non-empty plugin selection submits scope.pluginIds = { mode: 'allow', ids }", async () => {
    const addRoutineV2 = vi.fn().mockResolvedValue({ ok: true, routine: makeRoutineRecord() });
    const api = makeStubApi({
      pluginCards: [
        {
          id: "plugin-a",
          name: "Plugin A",
          description: "",
          sampleTools: [],
          capabilities: [],
          tools: ["tool_a"],
          loadStatus: "loaded",
        },
      ],
      addRoutineV2,
    });

    const { getByTestId, getByText } = render(
      <AddRoutineModal api={api} onClose={vi.fn()} onAdded={vi.fn()} />,
    );

    await waitFor(() => {
      getByTestId("routine-allowed-plugin-plugin-a");
    });

    fireEvent.change(getByTestId("pre-prompt-input"), { target: { value: "do thing" } });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0]!, { target: { value: validFutureDate() } });
    fireEvent.click(getByTestId("routine-allowed-plugin-plugin-a"));

    const registerBtn = getByText("등록") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(registerBtn);
    });

    await waitFor(() => {
      expect(addRoutineV2).toHaveBeenCalledTimes(1);
    });
    const payload = addRoutineV2.mock.calls[0]![0] as AddRoutineInput;
    expect(payload.scope?.pluginIds).toEqual({ mode: "allow", ids: ["plugin-a"] });
  });
});
