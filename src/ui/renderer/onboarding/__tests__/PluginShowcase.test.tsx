// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  PluginShowcase,
  resolveShowcaseCards,
  scenarioToPluginId,
  type PluginShowcaseApi,
} from "../PluginShowcase.js";

function makeApi(): {
  api: PluginShowcaseApi;
  tourStart: ReturnType<typeof vi.fn>;
} {
  const tourStart = vi.fn(async () => ({ ok: true }));
  return {
    api: { tour: { start: tourStart } },
    tourStart,
  };
}

describe("resolveShowcaseCards", () => {
  it("returns empty when no installed plugins", () => {
    expect(resolveShowcaseCards([])).toEqual([]);
  });

  it("filters catalog to installed ids in catalog order", () => {
    const cards = resolveShowcaseCards([
      "agent-hub",
      "meeting",
      "local-indexer",
    ]);
    expect(cards.map((c) => c.id)).toEqual([
      "meeting",
      "local-indexer",
      "agent-hub",
    ]);
  });

  it("appends unknown plugins as generic fallback cards", () => {
    const cards = resolveShowcaseCards(["meeting", "custom-plugin-xyz"]);
    expect(cards.map((c) => c.id)).toEqual(["meeting", "custom-plugin-xyz"]);
    const xyz = cards.find((c) => c.id === "custom-plugin-xyz");
    expect(xyz).toBeTruthy();
    expect(xyz?.emoji).toBe("🧩");
  });

  it("hoists the prioritized plugin to the top when set", () => {
    const cards = resolveShowcaseCards(
      ["meeting", "local-indexer", "work-proactive", "agent-hub"],
      "agent-hub",
    );
    expect(cards.map((c) => c.id)).toEqual([
      "agent-hub",
      "meeting",
      "local-indexer",
      "work-proactive",
    ]);
  });

  it("priority that matches the already-top card is a no-op", () => {
    const cards = resolveShowcaseCards(
      ["meeting", "local-indexer", "agent-hub"],
      "meeting",
    );
    expect(cards.map((c) => c.id)).toEqual([
      "meeting",
      "local-indexer",
      "agent-hub",
    ]);
  });

  it("priority that does not match any installed card preserves order", () => {
    const cards = resolveShowcaseCards(
      ["meeting", "local-indexer"],
      "nonexistent",
    );
    expect(cards.map((c) => c.id)).toEqual(["meeting", "local-indexer"]);
  });
});

describe("scenarioToPluginId", () => {
  it("maps each ScenarioShowcase id to the matching plugin id", () => {
    expect(scenarioToPluginId("meeting")).toBe("meeting");
    expect(scenarioToPluginId("docs")).toBe("local-indexer");
    expect(scenarioToPluginId("work")).toBe("work-proactive");
    expect(scenarioToPluginId("multi-agent")).toBe("agent-hub");
  });

  it("returns null for null / unknown ids", () => {
    expect(scenarioToPluginId(null)).toBeNull();
    expect(scenarioToPluginId(undefined)).toBeNull();
    expect(scenarioToPluginId("unknown")).toBeNull();
  });
});

describe("PluginShowcase", () => {
  it("renders nothing when open=false", () => {
    const { api } = makeApi();
    render(
      <PluginShowcase
        open={false}
        installedPluginIds={["meeting"]}
        api={api}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("plugin-showcase")).toBeNull();
  });

  it("shows empty state when installedPluginIds is empty", () => {
    const { api } = makeApi();
    render(
      <PluginShowcase
        open
        installedPluginIds={[]}
        api={api}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("plugin-showcase:empty")).toBeTruthy();
    expect(screen.queryByTestId("plugin-showcase:list")).toBeNull();
  });

  it("renders one card per installed plugin", () => {
    const { api } = makeApi();
    render(
      <PluginShowcase
        open
        installedPluginIds={["meeting", "local-indexer"]}
        api={api}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("plugin-showcase:card:meeting")).toBeTruthy();
    expect(
      screen.getByTestId("plugin-showcase:card:local-indexer"),
    ).toBeTruthy();
  });

  it("'둘러보기' fires api.tour.start with the per-plugin scenarioId", () => {
    const { api, tourStart } = makeApi();
    render(
      <PluginShowcase
        open
        installedPluginIds={["meeting"]}
        api={api}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-showcase:card:meeting:explore"));
    expect(tourStart).toHaveBeenCalledWith("meeting-walkthrough");
  });

  it("'끝내기 →' fires onClose", () => {
    const { api } = makeApi();
    const onClose = vi.fn();
    render(
      <PluginShowcase
        open
        installedPluginIds={["meeting"]}
        api={api}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-showcase:close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
