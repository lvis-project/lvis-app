import { describe, expect, it } from "vitest";

import { LLM_VENDORS } from "../../shared/llm-vendor-defaults.js";
import { estimateMessageTokensForWire } from "../auto-compact.js";
import type { GenericMessage, LLMProvider, ThinkingBlock } from "../llm/types.js";
import { serializeMessageForEstimation } from "../llm/types.js";
import { genericToModelMessages } from "../llm/vercel/adapter.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";

const ASSISTANT: Extract<GenericMessage, { role: "assistant" }> = {
  role: "assistant",
  content: "I will inspect the file.",
  toolCalls: [{ id: "call-1", name: "read_file", input: { path: "notes.txt" } }],
};
const THINKING = "Private reasoning that is also rendered in the transcript. ".repeat(2_000);
const SIGNED_BLOCK: ThinkingBlock = { thinking: THINKING, signature: "retained-signature" };

describe("request reasoning projection", () => {
  it.each(LLM_VENDORS)("keeps estimates invariant when display thought leaves the %s request unchanged", (vendor) => {
    const withThought = { ...ASSISTANT, thought: THINKING };
    const input = { systemPrompt: "Inspect the requested file.", toolSchemas: [] };

    expect(genericToModelMessages([withThought], vendor))
      .toEqual(genericToModelMessages([ASSISTANT], vendor));
    expect(estimateRequestInputProjection({ ...input, messages: [withThought] }, { vendor }))
      .toEqual(estimateRequestInputProjection({ ...input, messages: [ASSISTANT] }, { vendor }));
    expect(serializeMessageForEstimation(withThought)).toContain(THINKING);
    expect(withThought.thought).toBe(THINKING);
  });

  it.each(LLM_VENDORS)("counts signed blocks only if the %s mapper replays them", (vendor) => {
    const signed = { ...ASSISTANT, thinkingBlocks: [SIGNED_BLOCK] };
    const withDisplayCopy = { ...signed, thought: THINKING };
    const wire = genericToModelMessages([signed], vendor);
    const plainWire = genericToModelMessages([ASSISTANT], vendor);
    const baseline = estimateMessageTokensForWire(ASSISTANT, vendor);
    const projected = estimateMessageTokensForWire(signed, vendor);

    expect(genericToModelMessages([withDisplayCopy], vendor)).toEqual(wire);
    expect(estimateMessageTokensForWire(withDisplayCopy, vendor)).toBe(projected);
    if (vendor === "claude") {
      expect(wire).not.toEqual(plainWire);
      expect(projected).toBeGreaterThan(baseline + 10_000);
    } else {
      expect(wire).toEqual(plainWire);
      expect(projected).toBe(baseline);
    }
  });

  it("excludes unsigned blocks from the route that requires signatures", () => {
    const unsigned = {
      ...ASSISTANT,
      thinkingBlocks: [
        { thinking: THINKING, signature: "" },
        { thinking: THINKING, signature: undefined } as unknown as ThinkingBlock,
      ],
    };
    expect(genericToModelMessages([unsigned], "claude"))
      .toEqual(genericToModelMessages([ASSISTANT], "claude"));
    expect(estimateMessageTokensForWire(unsigned, "claude"))
      .toBe(estimateMessageTokensForWire(ASSISTANT, "claude"));
  });

  it("preserves signed empty blocks and signatures exactly as the mapper sends them", () => {
    const signedEmpty = {
      ...ASSISTANT,
      thinkingBlocks: [{ thinking: "", signature: " " }],
    };
    const wire = genericToModelMessages([signedEmpty], "claude");
    expect(wire[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "reasoning", text: "", providerOptions: { anthropic: { signature: " " } } },
        { type: "text", text: ASSISTANT.content },
        { type: "tool-call" }],
    });
    expect(estimateMessageTokensForWire(signedEmpty, "claude"))
      .toBeGreaterThan(estimateMessageTokensForWire(ASSISTANT, "claude"));
  });

  it("conservatively counts valid signed blocks when the route is unknown without counting their display copy", () => {
    const signed = { ...ASSISTANT, thinkingBlocks: [SIGNED_BLOCK] };
    const withDisplayCopy = { ...signed, thought: THINKING };
    const unsigned = { ...ASSISTANT, thinkingBlocks: [{ thinking: THINKING, signature: "" }] };

    expect(estimateMessageTokensForWire(signed))
      .toBe(estimateMessageTokensForWire(signed, "claude"));
    expect(estimateMessageTokensForWire(withDisplayCopy))
      .toBe(estimateMessageTokensForWire(signed));
    expect(estimateMessageTokensForWire(unsigned))
      .toBe(estimateMessageTokensForWire(ASSISTANT));
  });

  it("retains a transport-owned projection and passes its full history through unchanged", () => {
    const message = { ...ASSISTANT, thought: THINKING, thinkingBlocks: [SIGNED_BLOCK] };
    const messages = [message];
    const nativeProjection = { totalTokens: 1_200, messageTokens: 1_000, systemPromptTokens: 150, toolSchemaTokens: 50 };
    const provider: Pick<LLMProvider, "projectRequestInput"> = {
      projectRequestInput: (input) => {
        expect(input.messages).toBe(messages);
        expect(input.messages[0]).toBe(message);
        return nativeProjection;
      },
    };

    expect(estimateRequestInputProjection({ systemPrompt: "system", messages, toolSchemas: [] }, provider))
      .toBe(nativeProjection);
  });
});
