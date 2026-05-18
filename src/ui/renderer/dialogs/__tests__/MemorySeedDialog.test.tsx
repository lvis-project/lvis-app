// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemorySeedDialog,
  composeUrgentMemorySeed,
} from "../MemorySeedDialog.js";
import type { LvisApi } from "../../types.js";

type StubbedApi = Pick<LvisApi, "memoryUpdateIndexSections" | "tour" | "updateSettings">;

function makeApi(overrides: Partial<StubbedApi> = {}): {
  api: StubbedApi;
  memoryUpdateIndexSections: ReturnType<typeof vi.fn>;
  tourStart: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
} {
  const memoryUpdateIndexSections = vi.fn(async () => ({ ok: true }));
  const tourStart = vi.fn(async () => ({ ok: true, scenarioId: "first-boot-essentials" }));
  const updateSettings = vi.fn(async () => ({ ok: true }));
  const api = {
    memoryUpdateIndexSections,
    tour: {
      getState: vi.fn(),
      markComplete: vi.fn(),
      dismiss: vi.fn(),
      start: tourStart,
      onStart: vi.fn(() => () => {}),
    } as unknown as LvisApi["tour"],
    updateSettings,
    ...overrides,
  } as StubbedApi;
  return { api, memoryUpdateIndexSections, tourStart, updateSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("composeUrgentMemorySeed", () => {
  it("emits both 호칭 + 자기소개 lines when both are present", () => {
    expect(composeUrgentMemorySeed("Ken", "PM, 회의록 정리")).toBe(
      "- 호칭: Ken\n- 자기소개: PM, 회의록 정리",
    );
  });

  it("drops empty fields and trims whitespace", () => {
    expect(composeUrgentMemorySeed("   ", "  intro  ")).toBe("- 자기소개: intro");
    expect(composeUrgentMemorySeed("Ken", "")).toBe("- 호칭: Ken");
    expect(composeUrgentMemorySeed("", "")).toBe("");
  });
});

describe("MemorySeedDialog", () => {
  it("renders only when open=true", () => {
    const { api } = makeApi();
    const { rerender } = render(
      <MemorySeedDialog open={false} onOpenChange={() => {}} api={api} onDismissed={() => {}} />,
    );
    expect(screen.queryByTestId("memory-seed-dialog")).toBeNull();

    rerender(
      <MemorySeedDialog open onOpenChange={() => {}} api={api} onDismissed={() => {}} />,
    );
    expect(screen.getByTestId("memory-seed-dialog")).toBeTruthy();
  });

  it("shows the fallback recommendation chip when intro is empty", () => {
    const { api } = makeApi();
    render(
      <MemorySeedDialog open onOpenChange={() => {}} api={api} onDismissed={() => {}} />,
    );
    expect(screen.getByTestId("memory-seed-dialog:chip:chat-basics")).toBeTruthy();
  });

  it("updates the chip strip live as the intro changes", () => {
    const { api } = makeApi();
    render(
      <MemorySeedDialog open onOpenChange={() => {}} api={api} onDismissed={() => {}} />,
    );
    const intro = screen.getByTestId("memory-seed-dialog:intro");
    fireEvent.change(intro, { target: { value: "매주 회의가 많은 PM. 일정 관리 자동화" } });

    expect(screen.getByTestId("memory-seed-dialog:chip:meeting")).toBeTruthy();
    // 일정 keyword hits ms-graph row (label "calendar (MS Graph)").
    expect(screen.getByTestId("memory-seed-dialog:chip:ms-graph")).toBeTruthy();
    // Fallback chip must disappear once a real match exists.
    expect(screen.queryByTestId("memory-seed-dialog:chip:chat-basics")).toBeNull();
  });

  it("on submit, persists MEMORY.md urgent memory, marks onboarding complete, and starts the tour", async () => {
    const { api, memoryUpdateIndexSections, tourStart } = makeApi();
    const onDismissed = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <MemorySeedDialog open onOpenChange={onOpenChange} api={api} onDismissed={onDismissed} />,
    );

    fireEvent.change(screen.getByTestId("memory-seed-dialog:name"), {
      target: { value: "Ken" },
    });
    fireEvent.change(screen.getByTestId("memory-seed-dialog:intro"), {
      target: { value: "PM" },
    });
    fireEvent.click(screen.getByTestId("memory-seed-dialog:submit"));

    await waitFor(() => {
      expect(memoryUpdateIndexSections).toHaveBeenCalledWith({
        urgentMemory: "- 호칭: Ken\n- 자기소개: PM",
      });
    });
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(tourStart).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("on skip, does NOT persist memory but still flips onboarding + launches the tour", async () => {
    const { api, memoryUpdateIndexSections, tourStart } = makeApi();
    const onDismissed = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <MemorySeedDialog open onOpenChange={onOpenChange} api={api} onDismissed={onDismissed} />,
    );
    fireEvent.click(screen.getByTestId("memory-seed-dialog:skip"));

    expect(memoryUpdateIndexSections).not.toHaveBeenCalled();
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(tourStart).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("skips MEMORY.md write when both name and intro are blank but still advances", async () => {
    const { api, memoryUpdateIndexSections, tourStart } = makeApi();
    const onDismissed = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <MemorySeedDialog open onOpenChange={onOpenChange} api={api} onDismissed={onDismissed} />,
    );
    fireEvent.click(screen.getByTestId("memory-seed-dialog:submit"));

    await waitFor(() => {
      expect(onDismissed).toHaveBeenCalledTimes(1);
    });
    expect(memoryUpdateIndexSections).not.toHaveBeenCalled();
    expect(tourStart).toHaveBeenCalledWith("first-boot-essentials");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still dismisses + starts tour when memoryUpdateIndexSections throws", async () => {
    const { api, tourStart } = makeApi({
      memoryUpdateIndexSections: vi.fn(async () => {
        throw new Error("disk write failed");
      }),
    } as Partial<StubbedApi>);
    const onDismissed = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <MemorySeedDialog open onOpenChange={onOpenChange} api={api} onDismissed={onDismissed} />,
    );
    fireEvent.change(screen.getByTestId("memory-seed-dialog:name"), {
      target: { value: "Ken" },
    });
    fireEvent.click(screen.getByTestId("memory-seed-dialog:submit"));

    await waitFor(() => {
      expect(onDismissed).toHaveBeenCalledTimes(1);
    });
    expect(tourStart).toHaveBeenCalledWith("first-boot-essentials");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
