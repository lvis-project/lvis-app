/**
 * Send mode → turn-entry origin.
 *
 * This map replaced a nested ternary whose fallback was `"user-keyboard"`. That
 * fallback was the single most dangerous fail-open in the staged-origin design:
 * a staged mode nobody remembered to branch on would have sent actor-authored
 * text as a fully trusted, user-typed turn — no force-ask, no untrusted framing,
 * a real user bubble, slash commands enabled. These tests pin the property.
 */
import { describe, it, expect } from "vitest";

import { SEND_MODE_ORIGIN, type SendMode } from "../use-send-message.js";

const STAGED_MODES: SendMode[] = ["trigger-import", "app-message", "mcp-prompt"];

describe("SEND_MODE_ORIGIN", () => {
  it("maps only the default mode to user-keyboard", () => {
    expect(SEND_MODE_ORIGIN.default).toBe("user-keyboard");
    const trusted = Object.entries(SEND_MODE_ORIGIN)
      .filter(([, origin]) => origin === "user-keyboard")
      .map(([mode]) => mode);
    expect(trusted).toEqual(["default"]);
  });

  it("gives every staged mode its own non-user origin", () => {
    for (const mode of STAGED_MODES) {
      const origin = SEND_MODE_ORIGIN[mode];
      expect(origin).toBeDefined();
      expect(origin).not.toBe("user-keyboard");
    }
    const stagedOrigins = STAGED_MODES.map((mode) => SEND_MODE_ORIGIN[mode]);
    expect(new Set(stagedOrigins).size).toBe(STAGED_MODES.length);
  });

  it("routes the MCP prompt mode to the mcp-prompt-emitted origin", () => {
    expect(SEND_MODE_ORIGIN["mcp-prompt"]).toBe("mcp-prompt-emitted");
  });
});
