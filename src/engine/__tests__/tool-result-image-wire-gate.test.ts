/**
 * "Does this tool_result's image actually reach the provider?" — one predicate,
 * two consumers that must not disagree.
 *
 * The wire mapper drops a `tool_result` image on every vendor whose tool role
 * is text-only; the token estimator charged 765 tokens for it regardless,
 * because its signature had no vendor. These tests run BOTH real deciders over
 * the same rows and assert the estimator charges the image exactly when the
 * mapper puts it on the wire.
 */
import { describe, expect, it } from "vitest";

import type { GenericMessage, LLMVendor, ToolSchema } from "../llm/types.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { genericToModelMessages } from "../llm/vercel/adapter.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { vendorCarriesToolResultImage } from "../../shared/multimodal-token-estimate.js";

const IMAGE_ROW: GenericMessage = {
  role: "tool_result",
  toolUseId: "tu-image",
  toolName: "view_image",
  content: "[image loaded]",
  image: { data: "AAAA", mimeType: "image/png" },
};

const PLACEHOLDER_ROW: GenericMessage = {
  role: "tool_result",
  toolUseId: "tu-image",
  toolName: "view_image",
  content: "[image loaded]",
};

const NO_SCHEMAS: ToolSchema[] = [];

/** True when the mapper actually emitted image bytes for this vendor. */
function mapperSendsImage(vendor: LLMVendor): boolean {
  const [mapped] = genericToModelMessages([IMAGE_ROW], vendor);
  const output = (mapped as { content: Array<{ output?: { type?: string } }> }).content[0].output;
  return output?.type === "content";
}

const VENDORS: LLMVendor[] = ["claude", "gemini", "openai"];

describe("tool_result image wire gate — mapper and estimator agree", () => {
  it.each(VENDORS)("charges the image overhead for %s exactly when the mapper sends it", (vendor) => {
    const sends = mapperSendsImage(vendor);
    expect(sends).toBe(vendorCarriesToolResultImage(vendor));

    const withImage = estimateMessagesTokens([IMAGE_ROW], vendor);
    const placeholderOnly = estimateMessagesTokens([PLACEHOLDER_ROW], vendor);

    if (sends) {
      expect(withImage).toBeGreaterThan(placeholderOnly + 500);
    } else {
      expect(withImage).toBe(placeholderOnly);
    }
  });

  it("keeps the Claude-shaped answer when no vendor is supplied", () => {
    // The mapper defaults `vendor` to "claude"; the estimator must match, or an
    // unparameterized caller silently changes its own answer.
    expect(estimateMessagesTokens([IMAGE_ROW])).toBe(estimateMessagesTokens([IMAGE_ROW], "claude"));
  });
});

describe("estimateRequestInputProjection — the serving vendor reaches the estimator", () => {
  const projectFor = (vendor: LLMVendor | undefined) =>
    estimateRequestInputProjection(
      { systemPrompt: "", messages: [IMAGE_ROW], toolSchemas: NO_SCHEMAS },
      vendor === undefined ? undefined : ({ vendor } as never),
    );

  it("charges the image on Claude and not on a text-only tool-role vendor", () => {
    const claude = projectFor("claude").messageTokens;
    const gemini = projectFor("gemini").messageTokens;
    expect(claude).toBeGreaterThan(gemini + 500);
  });

  it("keeps totalTokens consistent with the vendor-aware message count", () => {
    const projection = projectFor("gemini");
    expect(projection.messageTokens).toBe(estimateMessagesTokens([IMAGE_ROW], "gemini"));
    expect(projection.totalTokens).toBe(
      projection.systemPromptTokens + projection.messageTokens + projection.toolSchemaTokens,
    );
  });

  it("falls back to the Claude-shaped count when no provider is in hand", () => {
    expect(projectFor(undefined).messageTokens).toBe(projectFor("claude").messageTokens);
  });

  it("lets a provider-owned projection win over the vendor-aware fallback", () => {
    const provider = {
      vendor: "gemini",
      projectRequestInput: () => ({
        totalTokens: 42,
        systemPromptTokens: 0,
        messageTokens: 42,
        toolSchemaTokens: 0,
      }),
    };
    const projection = estimateRequestInputProjection(
      { systemPrompt: "", messages: [IMAGE_ROW], toolSchemas: NO_SCHEMAS },
      provider as never,
    );
    expect(projection.messageTokens).toBe(42);
  });
});
