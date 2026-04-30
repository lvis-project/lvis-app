/**
 * UX Track 3 — visual snapshot for migrated shared components.
 *
 * Asserts that the migrated components emit the SAME class string in light
 * and dark themes — i.e. they consume semantic tokens, not theme-literal
 * Tailwind palette utilities (`bg-slate-800`, `dark:…`, etc.).
 *
 * The component output is identical across themes because the semantic
 * Tailwind classes (`bg-background`, `text-foreground`) are theme-agnostic
 * — the actual color comes from the CSS variable swap on `<html>`.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

function renderInTheme(preference: "light" | "dark", node: JSX.Element) {
  document.documentElement.removeAttribute("data-theme");
  const result = render(<ThemeProvider initialPreference={preference}>{node}</ThemeProvider>);
  return {
    html: result.container.innerHTML,
    rootTheme: document.documentElement.getAttribute("data-theme"),
    cleanup: () => result.unmount(),
  };
}

describe("Theme snapshots — semantic-token components are theme-invariant", () => {
  it("Button (primary) renders identical markup in light vs dark", () => {
    const light = renderInTheme("light", <Button>Click</Button>);
    expect(light.rootTheme).toBe("light");
    light.cleanup();
    const dark = renderInTheme("dark", <Button>Click</Button>);
    expect(dark.rootTheme).toBe("dark");
    expect(dark.html).toBe(light.html);
    dark.cleanup();
  });

  it("Button variants still emit theme-agnostic class strings", () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost"] as const) {
      const light = renderInTheme("light", <Button variant={variant}>x</Button>);
      light.cleanup();
      const dark = renderInTheme("dark", <Button variant={variant}>x</Button>);
      expect(dark.html, `variant=${variant} differs between themes`).toBe(light.html);
      dark.cleanup();
    }
  });

  it("Input is theme-invariant", () => {
    const light = renderInTheme("light", <Input placeholder="search" />);
    light.cleanup();
    const dark = renderInTheme("dark", <Input placeholder="search" />);
    expect(dark.html).toBe(light.html);
    dark.cleanup();
  });

  it("Card composition is theme-invariant", () => {
    const tree = (
      <Card>
        <CardHeader><CardTitle>Title</CardTitle></CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    );
    const light = renderInTheme("light", tree);
    light.cleanup();
    const dark = renderInTheme("dark", tree);
    expect(dark.html).toBe(light.html);
    dark.cleanup();
  });

  it("Button does NOT include any theme-literal Tailwind palette utilities", () => {
    const { html, cleanup } = renderInTheme("dark", <Button>x</Button>);
    // theme-literal palettes (the migration anti-pattern)
    expect(html).not.toMatch(/\bbg-slate-\d+\b/);
    expect(html).not.toMatch(/\bbg-zinc-\d+\b/);
    expect(html).not.toMatch(/\bbg-gray-\d+\b/);
    expect(html).not.toMatch(/\btext-white\b/);
    expect(html).not.toMatch(/\btext-black\b/);
    cleanup();
  });
});
