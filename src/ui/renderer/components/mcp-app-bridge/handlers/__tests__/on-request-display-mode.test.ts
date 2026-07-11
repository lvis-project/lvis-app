// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createOnRequestDisplayMode } from "../on-request-display-mode.js";
import {
  MCP_APP_AVAILABLE_DISPLAY_MODES,
  type McpUiDisplayMode,
} from "../../../../../../shared/mcp-app-display-mode.js";

type Handler = (p: { mode: string }) => Promise<{ mode: McpUiDisplayMode }>;

/** A card sitting in `current`, whose applier always succeeds. */
function build(current: McpUiDisplayMode, applied?: McpUiDisplayMode) {
  let mode = current;
  const applyMode = vi.fn(async (next: McpUiDisplayMode) => {
    // `applied` models a host that could not honour the request and stayed put.
    mode = applied ?? next;
    return mode;
  });
  const getMode = vi.fn(() => mode);
  return {
    applyMode,
    getMode,
    handler: createOnRequestDisplayMode({ getMode, applyMode }) as unknown as Handler,
  };
}

describe("createOnRequestDisplayMode — the result is the mode ACTUALLY applied", () => {
  it("applies an advertised mode and answers with it", async () => {
    const { handler, applyMode } = build("inline");

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "fullscreen" });
    expect(applyMode).toHaveBeenCalledWith("fullscreen");
  });

  it("answers with the APPLIED mode, not the requested one, when the host stayed put", async () => {
    // e.g. `mcp.openDetached` came back `{ ok: false }` — the card never moved.
    const { handler } = build("inline", "inline");

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "inline" });
  });

  it("returns the CURRENT mode (never a throw) when the applier fails", async () => {
    const getMode = vi.fn((): McpUiDisplayMode => "inline");
    const applyMode = vi.fn(async () => {
      throw new Error("unauthorized-frame");
    });
    const handler = createOnRequestDisplayMode({ getMode, applyMode }) as unknown as Handler;

    await expect(handler({ mode: "fullscreen" })).resolves.toEqual({ mode: "inline" });
  });
});

describe("createOnRequestDisplayMode — an unadvertised mode is refused, once, here", () => {
  it("rejects `pip` (not in the host's advertised set) with the card's current mode", async () => {
    const { handler, applyMode } = build("inline");

    await expect(handler({ mode: "pip" })).resolves.toEqual({ mode: "inline" });
    // The refusal is a NO-OP, not a failed apply: nothing touched a window.
    expect(applyMode).not.toHaveBeenCalled();
  });

  it("refuses `pip` from the fullscreen surface too — and answers `fullscreen`", async () => {
    const { handler, applyMode } = build("fullscreen");

    await expect(handler({ mode: "pip" })).resolves.toEqual({ mode: "fullscreen" });
    expect(applyMode).not.toHaveBeenCalled();
  });

  it("refuses garbage a non-conforming app could send", async () => {
    const { handler, applyMode } = build("inline");

    for (const mode of ["", "INLINE", "windowed", "../../etc"]) {
      await expect(handler({ mode })).resolves.toEqual({ mode: "inline" });
    }
    expect(applyMode).not.toHaveBeenCalled();
  });

  it("honours exactly the advertised set — the same SoT the host context publishes", async () => {
    for (const mode of MCP_APP_AVAILABLE_DISPLAY_MODES) {
      const { handler, applyMode } = build("inline");
      await expect(handler({ mode })).resolves.toEqual({ mode });
      if (mode !== "inline") expect(applyMode).toHaveBeenCalledWith(mode);
    }
  });
});
