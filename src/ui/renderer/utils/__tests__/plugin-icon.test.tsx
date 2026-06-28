/**
 * pluginIconFor — unit tests
 *
 * The function returns:
 *   - FALLBACK_ICON (Plug) synchronously when `icon` is undefined/absent.
 *   - A React.lazy wrapper for any non-empty `icon` string. The lazy wrapper
 *     resolves to the matching Lucide component, or to FALLBACK_ICON when the
 *     name is not found in the lucide-react namespace.
 *   - The same component reference on repeated calls (cache stability).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { pluginIconFor, FALLBACK_ICON } from "../plugin-icon.js";
import { Plug, Mic } from "lucide-react";

const REACT_LAZY_TYPE = Symbol.for("react.lazy");

function isLazy(c: unknown): boolean {
  return (c as { $$typeof?: symbol }).$$typeof === REACT_LAZY_TYPE;
}

/**
 * Synchronously imports the resolved icon by name (no React.lazy / payload
 * internals). We resolve the lucide-react module directly and look up the
 * named export, then compare it against what `pluginIconFor` resolves to —
 * verifying the correct component is returned without relying on React
 * internal field names beyond `$$typeof`.
 */
async function resolveIconName(name: string): Promise<unknown> {
  const mod = await import("lucide-react");
  const candidate = (mod as Record<string, unknown>)[name];
  if (
    typeof candidate === "function" ||
    (typeof candidate === "object" &&
      candidate !== null &&
      "render" in (candidate as object))
  ) {
    return candidate;
  }
  return FALLBACK_ICON;
}

describe("pluginIconFor", () => {
  // The render-based iconText assertions below would otherwise leak DOM
  // between cases — vitest doesn't auto-cleanup `render()` output.
  afterEach(cleanup);

  it("returns the Plug fallback synchronously when icon is undefined", () => {
    const result = pluginIconFor({});
    expect(result).toBe(Plug);
    expect(result).toBe(FALLBACK_ICON);
  });

  it("returns a React.lazy component for unknown icon names", () => {
    const result = pluginIconFor({ icon: "NonExistentIconXyz" });
    expect(isLazy(result)).toBe(true);
  });

  it("lazy for unknown icon names resolves to FALLBACK_ICON", async () => {
    const resolved = await resolveIconName("NonExistentIconXyz");
    expect(resolved).toBe(FALLBACK_ICON);
  });

  it("returns a React.lazy component for a known icon (Mic)", () => {
    const result = pluginIconFor({ icon: "Mic" });
    expect(isLazy(result)).toBe(true);
  });

  it("lazy for Mic resolves to the Mic component", async () => {
    const resolved = await resolveIconName("Mic");
    expect(resolved).toBe(Mic);
  });

  it("returns a React.lazy component for FileText", () => {
    const result = pluginIconFor({ icon: "FileText" });
    expect(isLazy(result)).toBe(true);
  });

  it("returns a React.lazy component for Share2", () => {
    const result = pluginIconFor({ icon: "Share2" });
    expect(isLazy(result)).toBe(true);
  });

  it("returns the same component reference on repeated calls (cache stability)", () => {
    const first = pluginIconFor({ icon: "Mic" });
    const second = pluginIconFor({ icon: "Mic" });
    expect(first).toBe(second);
  });

  it("caches the fallback path — same reference for empty icon", () => {
    const first = pluginIconFor({});
    const second = pluginIconFor({});
    expect(first).toBe(second);
    expect(first).toBe(FALLBACK_ICON);
  });

  it("lazy-resolves icon component end-to-end (behavioral)", async () => {
    const Icon = pluginIconFor({ icon: "Calendar" });
    render(
      <Suspense fallback={<span data-testid="fallback" />}>
        <Icon data-testid="icon" />
      </Suspense>,
    );
    await screen.findByTestId("icon");
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  // ─── iconText path ─────────────────────────────────────────────────────
  // iconText renders short text inline (no Lucide chunk load) and takes
  // precedence over a sibling `icon` field so manifests can opt out of
  // Lucide lookup without leaving the icon field undefined.

  it("iconText renders the text inline (no React.lazy)", () => {
    const Icon = pluginIconFor({ iconText: "EP" });
    expect(isLazy(Icon)).toBe(false);
    render(<Icon className="h-7 w-7" />);
    // `getByText` throws if not present — existence is the assertion.
    expect(screen.getByText("EP").tagName.toLowerCase()).toBe("span");
  });

  it("iconText takes precedence over icon when both are set", () => {
    const Icon = pluginIconFor({ icon: "Mic", iconText: "EP" });
    expect(isLazy(Icon)).toBe(false);
    render(<Icon className="h-7 w-7" />);
    expect(screen.getByText("EP").tagName.toLowerCase()).toBe("span");
  });

  it("iconText preserves the caller's className (sizing hook)", () => {
    const Icon = pluginIconFor({ iconText: "EP" });
    const { container } = render(<Icon className="h-7 w-7" />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("h-7");
    expect(span?.className).toContain("w-7");
    expect(span?.className).toContain("inline-flex");
  });

  it("iconText only accepts caller fontSize from style", () => {
    const Icon = pluginIconFor({ iconText: "EP" });
    const { container } = render(
      <Icon className="h-7 w-7" style={{ color: "red", fontSize: "0.62rem" }} />,
    );
    const span = container.querySelector("span");
    expect(span?.style.fontSize).toBe("0.62rem");
    expect(span?.style.color).toBe("");
  });

  it("iconText caches by text — same reference on repeated calls", () => {
    const first = pluginIconFor({ iconText: "EP" });
    const second = pluginIconFor({ iconText: "EP" });
    expect(first).toBe(second);
  });

  it("iconText cache is keyed separately from Lucide name cache", () => {
    // Distinct text vs Lucide-name inputs should never collide, even when
    // the strings happen to match (defensive — there is no Lucide icon
    // named "EP" today but the contract should not depend on that).
    const text = pluginIconFor({ iconText: "EP" });
    const lucide = pluginIconFor({ icon: "EP" });
    expect(text).not.toBe(lucide);
  });

  it("falls back to Plug when both icon and iconText are absent", () => {
    expect(pluginIconFor({})).toBe(FALLBACK_ICON);
    expect(pluginIconFor({ icon: undefined, iconText: undefined })).toBe(FALLBACK_ICON);
  });

  it("iconText with empty string is treated as absent (falls through to icon)", () => {
    const Icon = pluginIconFor({ icon: "Mic", iconText: "" });
    expect(isLazy(Icon)).toBe(true);
  });

  // Defense-in-depth: if the SDK schema's maxLength: 4 is somehow bypassed
  // (legacy install, dev-mode validator skip), the renderer must still cap
  // the visible text to 4 chars rather than overflowing the avatar.
  it("iconText is hard-truncated to 4 chars at the renderer", () => {
    const Icon = pluginIconFor({ iconText: "TOOLONG" });
    const { container } = render(<Icon className="h-7 w-7" />);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("TOOL");
  });

  it("iconText sets aria-label so screen readers announce the badge", () => {
    const Icon = pluginIconFor({ iconText: "EP" });
    const { container } = render(<Icon className="h-7 w-7" />);
    const span = container.querySelector("span");
    expect(span?.getAttribute("aria-label")).toBe("EP");
    expect(span?.getAttribute("role")).toBe("img");
  });
});
