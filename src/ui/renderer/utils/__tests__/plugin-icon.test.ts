/**
 * pluginIconFor — unit tests
 *
 * The function returns:
 *   - FALLBACK_ICON (Plug) synchronously when `icon` is undefined/absent.
 *   - A React.lazy wrapper for any non-empty `icon` string. The lazy wrapper
 *     resolves to the matching Lucide component, or to FALLBACK_ICON when the
 *     name is not found in the lucide-react namespace.
 */
import { describe, expect, it } from "vitest";
import { pluginIconFor, FALLBACK_ICON } from "../plugin-icon.js";
import { Plug, Mic } from "lucide-react";

const REACT_LAZY_TYPE = Symbol.for("react.lazy");

describe("pluginIconFor", () => {
  it("returns the Plug fallback synchronously when icon is undefined", () => {
    const result = pluginIconFor({});
    expect(result).toBe(Plug);
    expect(result).toBe(FALLBACK_ICON);
  });

  it("returns a React.lazy component even for unknown icon names", () => {
    const result = pluginIconFor({ icon: "NonExistentIconXyz" });
    expect((result as { $$typeof?: symbol }).$$typeof).toBe(REACT_LAZY_TYPE);
  });

  it("lazy for unknown icon names resolves to FALLBACK_ICON", async () => {
    const result = pluginIconFor({ icon: "NonExistentIconXyz" });
    const payload = (result as { _payload: { _result: () => Promise<{ default: unknown }> } })._payload;
    const mod = await payload._result();
    expect(mod.default).toBe(FALLBACK_ICON);
  });

  it("returns a React.lazy component for a known icon (Mic)", () => {
    const result = pluginIconFor({ icon: "Mic" });
    expect((result as { $$typeof?: symbol }).$$typeof).toBe(REACT_LAZY_TYPE);
  });

  it("lazy for Mic resolves to the Mic component", async () => {
    const result = pluginIconFor({ icon: "Mic" });
    const payload = (result as { _payload: { _result: () => Promise<{ default: unknown }> } })._payload;
    const mod = await payload._result();
    expect(mod.default).toBe(Mic);
  });

  it("returns a React.lazy component for FileText", () => {
    const result = pluginIconFor({ icon: "FileText" });
    expect((result as { $$typeof?: symbol }).$$typeof).toBe(REACT_LAZY_TYPE);
  });

  it("returns a React.lazy component for Share2", () => {
    const result = pluginIconFor({ icon: "Share2" });
    expect((result as { $$typeof?: symbol }).$$typeof).toBe(REACT_LAZY_TYPE);
  });
});
