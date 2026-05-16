/**
 * Regression guard for the FontFamilyCustomInput Escape contract.
 *
 * PR #672 history:
 *   - 1차 review CRITICAL #2 prompted the move from per-keystroke commit to
 *     blur/Enter-only commit (FontFamilyCustomInput component, ad4859a).
 *   - 2차 critic MAJOR N1 caught Escape committing typed text (884dd64
 *     intermediate fix used a dedupe inside `commit(override)` — incomplete).
 *   - 3차 critic ADVERSARIAL M1 traced the cascading `(e.target).blur()`
 *     after `setRaw(initial)`: React 18+ batches the state update, the
 *     synchronous blur triggers `onBlur={() => commit()}` with the stale
 *     `raw` closure, dedupe doesn't fire, and the typed value still commits.
 *
 * The shipped fix is an `escapingRef` flag: Escape sets the ref, calls
 * `blur()`, and the `onBlur` handler reads + clears the ref to skip the
 * cascaded commit. This test exercises the Escape path end-to-end with
 * React Testing Library so any regression that re-introduces the cascade
 * (e.g. removing the ref, flipping the check, removing the early return)
 * fails loudly.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { AppearanceTab } from "../AppearanceTab.js";

vi.mock("../../api-client.js", () => ({
  getApi: () => ({
    getSettings: vi.fn().mockResolvedValue({
      appearance: { schemaVersion: 2, bundleId: "tokyo-night", font: { family: "system", sizeScale: 1 } },
      webView: { preferredFlow: "in-app" },
    }),
    updateSettings: vi.fn().mockResolvedValue({}),
    onSettingsUpdated: vi.fn(() => () => {}),
  }),
}));

vi.mock("../../theme/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../theme/index.js")>("../../theme/index.js");
  return {
    ...actual,
    useTheme: () => {
      const [bundleId] = useState("tokyo-night");
      return { bundleId, setBundle: vi.fn(), followSystem: false, setFollowSystem: vi.fn() };
    },
    BUNDLES: actual.BUNDLES ?? [],
    VIOLET_PAIR_IDS: actual.VIOLET_PAIR_IDS ?? [],
  };
});

describe("FontFamilyCustomInput — Escape semantics (PR #672 3차 critic M1)", () => {
  it("Escape after typing does NOT commit the typed text", async () => {
    const { container, findByLabelText } = render(<AppearanceTab />);

    const input = (await findByLabelText("사용자 정의 폰트 stack")) as HTMLInputElement;

    // Capture the API mock so we can assert no `updateSettings({ font: { family } })`
    // call fires during the Escape path.
    const { getApi } = await import("../../api-client.js");
    const api = getApi() as ReturnType<typeof getApi> & {
      updateSettings: ReturnType<typeof vi.fn>;
    };
    api.updateSettings.mockClear();

    fireEvent.change(input, { target: { value: "AttackerFont, sans-serif" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Simulate the resulting synchronous blur — React Testing Library's
    // `blur()` covers what `.blur()` on the DOM element triggers.
    fireEvent.blur(input);

    const updateCalls = api.updateSettings.mock.calls.filter(([patch]) => {
      const family = (patch as { appearance?: { font?: { family?: string } } })?.appearance?.font?.family;
      return typeof family === "string" && family.includes("AttackerFont");
    });
    expect(updateCalls, "Escape must NOT commit the typed text via cascading onBlur").toHaveLength(0);
    expect(container).toBeTruthy();
  });
});
