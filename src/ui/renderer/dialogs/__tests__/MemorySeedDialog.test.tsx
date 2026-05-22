// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemorySeedDialog,
  composeUrgentMemorySeed,
  scenarioIntroPlaceholder,
} from "../MemorySeedDialog.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

type StubbedApi = Pick<LvisApi, "memoryUpdateIndexSections" | "tour" | "updateSettings">;

function memorySeedDialogApi(overrides: Partial<StubbedApi> = {}): {
  api: StubbedApi;
  memoryUpdateIndexSections: ReturnType<typeof vi.fn>;
  tourStart: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
} {
  const { api: baseApi } = makeMockLvisApi();
  Object.assign(baseApi, overrides);
  const api = baseApi as unknown as StubbedApi;
  const memoryUpdateIndexSections = baseApi.memoryUpdateIndexSections as ReturnType<typeof vi.fn>;
  const tourStart = (baseApi.tour as unknown as LvisApi["tour"]).start as ReturnType<typeof vi.fn>;
  const updateSettings = baseApi.updateSettings as ReturnType<typeof vi.fn>;
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
    const { api } = memorySeedDialogApi();
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
    const { api } = memorySeedDialogApi();
    render(
      <MemorySeedDialog open onOpenChange={() => {}} api={api} onDismissed={() => {}} />,
    );
    expect(screen.getByTestId("memory-seed-dialog:chip:chat-basics")).toBeTruthy();
  });

  it("updates the chip strip live as the intro changes", () => {
    const { api } = memorySeedDialogApi();
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
    const { api, memoryUpdateIndexSections, tourStart } = memorySeedDialogApi();
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
    const { api, memoryUpdateIndexSections, tourStart } = memorySeedDialogApi();
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
    const { api, memoryUpdateIndexSections, tourStart } = memorySeedDialogApi();
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
    const { api, tourStart } = memorySeedDialogApi({
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

describe("scenarioIntroPlaceholder", () => {
  it("returns a scenario-tinted hint for known ids", () => {
    expect(scenarioIntroPlaceholder("meeting")).toContain("회의");
    expect(scenarioIntroPlaceholder("docs")).toContain("문서");
    expect(scenarioIntroPlaceholder("work")).toContain("메일");
    expect(scenarioIntroPlaceholder("multi-agent")).toContain("리서치");
  });

  it("falls back to the legacy generic example for null / unknown ids", () => {
    expect(scenarioIntroPlaceholder(null)).toContain("매주 회의가 많은 PM");
    expect(scenarioIntroPlaceholder(undefined)).toContain("매주 회의가 많은 PM");
    expect(scenarioIntroPlaceholder("nope")).toContain("매주 회의가 많은 PM");
  });
});

describe("MemorySeedDialog placeholder integration", () => {
  it("applies the scenario-tinted placeholder when selectedScenarioId is set", () => {
    const { api } = memorySeedDialogApi();
    render(
      <MemorySeedDialog
        open
        api={api}
        onDismissed={() => {}}
        onOpenChange={() => {}}
        selectedScenarioId="docs"
      />,
    );
    const intro = screen.getByTestId(
      "memory-seed-dialog:intro",
    ) as HTMLTextAreaElement;
    expect(intro.placeholder).toContain("문서");
  });

  it("uses the legacy placeholder when selectedScenarioId is omitted", () => {
    const { api } = memorySeedDialogApi();
    render(
      <MemorySeedDialog
        open
        api={api}
        onDismissed={() => {}}
        onOpenChange={() => {}}
      />,
    );
    const intro = screen.getByTestId(
      "memory-seed-dialog:intro",
    ) as HTMLTextAreaElement;
    expect(intro.placeholder).toContain("매주 회의가 많은 PM");
  });
});
