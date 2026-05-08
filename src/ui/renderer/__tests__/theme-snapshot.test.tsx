/**
 * Theme system v2 — visual snapshot for migrated shared components.
 *
 * Asserts that components emit the SAME markup regardless of active bundle —
 * they consume semantic tokens (bg-background, text-foreground) and the actual
 * color comes from CSS variable swap on <html data-theme-bundle>.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

function renderInBundle(bundleId: string, node: JSX.Element) {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  const result = render(<ThemeProvider initialBundleId={bundleId}>{node}</ThemeProvider>);
  return {
    html: result.container.innerHTML,
    rootBundle: document.documentElement.getAttribute("data-theme-bundle"),
    cleanup: () => result.unmount(),
  };
}

describe("Theme snapshots — semantic-token components are bundle-invariant", () => {
  it("Button (primary) renders identical markup in tokyo-night vs forest", () => {
    const dark = renderInBundle("tokyo-night", <Button>Click</Button>);
    expect(dark.rootBundle).toBe("tokyo-night");
    dark.cleanup();
    const light = renderInBundle("forest", <Button>Click</Button>);
    expect(light.rootBundle).toBe("forest");
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Button variants still emit bundle-agnostic class strings", () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost"] as const) {
      const dark = renderInBundle("tokyo-night", <Button variant={variant}>x</Button>);
      dark.cleanup();
      const light = renderInBundle("forest", <Button variant={variant}>x</Button>);
      expect(light.html, `variant=${variant} differs between bundles`).toBe(dark.html);
      light.cleanup();
    }
  });

  it("Input is bundle-invariant", () => {
    const dark = renderInBundle("tokyo-night", <Input placeholder="search" />);
    dark.cleanup();
    const light = renderInBundle("forest", <Input placeholder="search" />);
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Card composition is bundle-invariant", () => {
    const tree = (
      <Card>
        <CardHeader><CardTitle>Title</CardTitle></CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    );
    const dark = renderInBundle("tokyo-night", tree);
    dark.cleanup();
    const light = renderInBundle("forest", tree);
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Button does NOT include any theme-literal Tailwind palette utilities", () => {
    const { html, cleanup } = renderInBundle("tokyo-night", <Button>x</Button>);
    expect(html).not.toMatch(/\bbg-slate-\d+\b/);
    expect(html).not.toMatch(/\bbg-zinc-\d+\b/);
    expect(html).not.toMatch(/\bbg-gray-\d+\b/);
    expect(html).not.toMatch(/\btext-white\b/);
    expect(html).not.toMatch(/\btext-black\b/);
    cleanup();
  });
});
