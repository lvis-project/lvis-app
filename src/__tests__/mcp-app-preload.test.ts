// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The preload does `import { ipcRenderer } from "electron"` at module top. jsdom has
// no electron, so mock it. Importing the module is safe in jsdom: the IIFE body is
// gated on `window.location.protocol === "lvis-mcp-app:"`, which is false here, so it
// never runs — only the exported helpers are exercised.
vi.mock("electron", () => ({ ipcRenderer: { on: vi.fn(), sendToHost: vi.fn() } }));

import { createInnerAppFrame, readHostDeclaredAllow } from "../mcp-app-preload.js";
import { INNER_SANDBOX_ATTR, MCP_APP_ALLOW_META_NAME } from "../shared/mcp-app-bridge-contract.js";

describe("mcp-app-preload — the inner iframe containment flags are host-owned", () => {
  it("always sets the spec sandbox pair `allow-scripts allow-same-origin` (constant)", () => {
    const frame = createInnerAppFrame(document, "<h1>app</h1>");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("sandbox")).toBe(INNER_SANDBOX_ATTR);
    expect(frame.srcdoc).toBe("<h1>app</h1>");
  });

  it("sets the `allow` attribute from the HOST-computed value, and omits it when empty", () => {
    // A card that declared a feature: main computed the allow string and the preload
    // copies it verbatim onto the frame.
    const withAllow = createInnerAppFrame(document, "<h1>app</h1>", "geolocation");
    expect(withAllow.getAttribute("allow")).toBe("geolocation");

    // A card that declared nothing: empty string ⇒ NO `allow` attribute at all
    // (fail-closed default — the frame is delegated no feature).
    const noAllow = createInnerAppFrame(document, "<h1>app</h1>");
    expect(noAllow.hasAttribute("allow")).toBe(false);
  });

  it("neither containment flag is influenced by wire input — both are host-owned", () => {
    // Regression guard: the old code applied a renderer-supplied `sandbox` string verbatim.
    // The helper takes (document, html, allow); html is the ONLY wire-derived input and it
    // reaches neither `sandbox` (a constant) nor `allow` (host-computed, passed separately).
    const a = createInnerAppFrame(document, "<p>a</p>", "geolocation");
    const b = createInnerAppFrame(document, "<p>b</p>", "geolocation");
    expect(a.getAttribute("sandbox")).toBe(b.getAttribute("sandbox"));
    expect(a.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(a.getAttribute("allow")).toBe(b.getAttribute("allow"));
  });
});

describe("mcp-app-preload — readHostDeclaredAllow reads the host-served meta, not the wire", () => {
  it("returns the meta content when present, empty string when absent", () => {
    const doc = document.implementation.createHTMLDocument("proxy");
    // Absent ⇒ empty ⇒ no feature delegated.
    expect(readHostDeclaredAllow(doc)).toBe("");

    // main writes the host-computed allow-list into THIS host-served document's meta tag.
    const meta = doc.createElement("meta");
    meta.setAttribute("name", MCP_APP_ALLOW_META_NAME);
    meta.setAttribute("content", "camera; microphone; geolocation");
    doc.head.appendChild(meta);
    expect(readHostDeclaredAllow(doc)).toBe("camera; microphone; geolocation");
  });
});
