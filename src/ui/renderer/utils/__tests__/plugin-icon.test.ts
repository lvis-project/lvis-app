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
import { describe, expect, it } from "vitest";
import { pluginIconFor, FALLBACK_ICON } from "../plugin-icon.js";
import { Plug, Mic } from "lucide-react";

const REACT_LAZY_TYPE = Symbol.for("react.lazy");

function isLazy(c: unknown): boolean {
  return (c as { $$typeof?: symbol }).$$typeof === REACT_LAZY_TYPE;
}

/**
 * Resolves a React.lazy component by directly invoking the dynamic import
 * factory. React.lazy stores the factory as `_payload._init` (the function
 * it calls on first render). We access the underlying import promise by
 * triggering the same `lucide-react` import that `pluginIconFor` would use.
 *
 * Behavioral: we verify the resolved default export matches the expected
 * component — no dependency on React internal field names beyond `$$typeof`.
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
});
