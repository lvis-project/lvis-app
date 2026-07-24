import { describe, expect, it } from "vitest";

import { formatAppMessageEnvelope } from "../mcp-app-message-source.js";
import { parseCanonicalStagedChatInput } from "../staged-chat-input.js";

const pluginEnvelope =
  '<imported-from-proactive source="overlay:daily-briefing">\nreview email\n</imported-from-proactive>';

describe("canonical staged chat input", () => {
  it("returns the complete parsed provenance for plugin and app envelopes", () => {
    expect(parseCanonicalStagedChatInput("plugin-emitted", pluginEnvelope)).toEqual({
      inputOrigin: "plugin-emitted",
      source: "overlay:daily-briefing",
      body: "review email",
    });
    expect(parseCanonicalStagedChatInput(
      "app-emitted",
      formatAppMessageEnvelope("review invoice", "app:cards"),
    )).toEqual({
      inputOrigin: "app-emitted",
      source: "app:cards",
      body: "review invoice",
    });
  });

  it.each([
    ["plugin prefix", "plugin-emitted", '<imported-from-proactive source="overlay:daily-briefing">review email'],
    ["plugin trailing text", "plugin-emitted", `${pluginEnvelope}\nnot part of the envelope`],
    ["plugin nested close", "plugin-emitted", '<imported-from-proactive source="overlay:daily-briefing">review</imported-from-proactive>outside</imported-from-proactive>'],
    ["plugin malformed source", "plugin-emitted", '<imported-from-proactive source="overlay:Bad">review email</imported-from-proactive>'],
    ["app prefix", "app-emitted", '<app-message source="app:cards">review invoice'],
    ["app trailing text", "app-emitted", '<app-message source="app:cards">review invoice</app-message> not part of the envelope'],
    ["app nested close", "app-emitted", '<app-message source="app:cards">review</app-message>outside</app-message>'],
    ["app malformed source", "app-emitted", '<app-message source="app:bad id">review invoice</app-message>'],
  ] as const)("rejects %s", (_label, inputOrigin, input) => {
    expect(parseCanonicalStagedChatInput(inputOrigin, input)).toBeNull();
  });

  it("does not infer staged provenance from an envelope-looking keyboard message", () => {
    expect(parseCanonicalStagedChatInput("user-keyboard", pluginEnvelope)).toBeNull();
  });
});
