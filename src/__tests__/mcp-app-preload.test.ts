// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The preload does `import { ipcRenderer } from "electron"` at module top. jsdom has
// no electron, so mock it. Importing the module is safe in jsdom: the IIFE body is
// gated on `window.location.protocol === "lvis-mcp-app:"`, which is false here, so it
// never runs — only the exported helper is exercised.
vi.mock("electron", () => ({ ipcRenderer: { on: vi.fn(), sendToHost: vi.fn() } }));

import { createInnerAppFrame } from "../mcp-app-preload.js";

describe("mcp-app-preload — the inner iframe sandbox flag is host-owned", () => {
  it("always sets sandbox='allow-scripts' (opaque origin), never allow-same-origin", () => {
    const frame = createInnerAppFrame(document, "<h1>app</h1>");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.srcdoc).toBe("<h1>app</h1>");
  });

  it("is not influenced by ANY wire input — the sandbox flag is a constant", () => {
    // Regression guard for security MINOR-1: the old code applied a renderer-supplied
    // `sandbox` string verbatim; a forged `allow-same-origin` would have collapsed the
    // opaque-origin containment. The helper takes only (document, html) — there is no
    // seam through which the wire could reach the sandbox attribute at all.
    const a = createInnerAppFrame(document, "<p>a</p>");
    const b = createInnerAppFrame(document, "<p>b</p>");
    expect(a.getAttribute("sandbox")).toBe(b.getAttribute("sandbox"));
    expect(a.getAttribute("sandbox")).toBe("allow-scripts");
  });
});
