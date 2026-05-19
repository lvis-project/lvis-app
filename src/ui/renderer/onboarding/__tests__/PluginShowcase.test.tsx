// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  PluginShowcase,
  resolveShowcaseCards,
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
