import { describe, expect, it } from "vitest";
import type { GenericMessage } from "../../engine/llm/types.js";
import { projectSubscriptionImageHistory } from "../subscription-image-history.js";
import { DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS as limits } from "../subscription-attachment-input.js";

function toolImage(id: number, bytes = 12): Extract<GenericMessage, { role: "tool_result" }> {
  const content = Buffer.alloc(bytes, id);
  Buffer.from("iVBORw0KGgo=", "base64").copy(content);
  return {
    role: "tool_result", toolUseId: `image-${id}`, toolName: "view_image", content: `Loaded image ${id}`,
    image: { data: content.toString("base64"), mimeType: "image/png" },
  };
}

function imageRounds(count: number): GenericMessage[] {
  return Array.from({ length: count }, (_, index): GenericMessage[] => [
    { role: "assistant", content: `Read image ${index}`, toolCalls: [{ id: `image-${index}`, name: "view_image", input: {} }] },
    toolImage(index),
  ]).flat();
}

function sentIds(messages: GenericMessage[]): string[] {
  return messages.flatMap((message) => message.role === "tool_result" && message.image ? [message.toolUseId] : []);
}

describe("projectSubscriptionImageHistory", () => {
  it("keeps the newest five images across repeated model rounds without editing the original history", () => {
    const messages = imageRounds(12);
    const before = structuredClone(messages);
    const projected = projectSubscriptionImageHistory(messages, limits);
    expect(sentIds(projected)).toEqual(["image-7", "image-8", "image-9", "image-10", "image-11"]);
    expect(projected[1]).toMatchObject({ toolUseId: "image-0", content: expect.stringContaining("Earlier image omitted") });
    expect(messages).toEqual(before);
    expect(sentIds(messages)).toHaveLength(12);
  });

  it("gives a new user turn its full image allowance ahead of older tool images", () => {
    const messages = imageRounds(5);
    messages.push({ role: "user", content: Array.from({ length: 5 }, (_, index) => ({
      type: "image" as const, image: `data:image/png;base64,${toolImage(index + 20).image!.data}`,
    })) });
    const projected = projectSubscriptionImageHistory(messages, limits);
    expect(sentIds(projected)).toEqual([]);
    expect(projected.at(-1)).toBe(messages.at(-1));
    expect(sentIds(messages)).toHaveLength(5);
  });

  it("replaces already delivered user images with markers when fresh tool images need the space", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: [{ type: "image", image: `data:image/png;base64,${toolImage(20).image!.data}` }] },
      { role: "assistant", content: "Now inspect these five images." },
      ...Array.from({ length: 5 }, (_, index) => toolImage(index)),
    ];
    const projected = projectSubscriptionImageHistory(messages, limits);
    expect(sentIds(projected)).toHaveLength(5);
    expect(projected[0]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Earlier user image omitted") }] });
    expect(messages[0]).toMatchObject({ content: [{ type: "image" }] });
  });

  it("reports fresh images that cannot fit as recoverable delivery errors instead of silently omitting them", () => {
    const messages = Array.from({ length: 6 }, (_, index) => toolImage(index));
    const projected = projectSubscriptionImageHistory(messages, limits);
    expect(sentIds(projected)).toEqual(["image-0", "image-1", "image-2", "image-3", "image-4"]);
    expect(projected[5]).toMatchObject({ toolUseId: "image-5", isError: true, content: expect.stringContaining("This image was not sent") });
    expect(projected[5]).not.toHaveProperty("image");
    expect(messages[5]).toHaveProperty("image");
    expect(messages[5]).not.toHaveProperty("isError");
  });

  it("bounds aggregate bytes before the count limit and keeps the newest image", () => {
    const messages = imageRounds(3);
    const projected = projectSubscriptionImageHistory(messages, { maxCount: 5, maxBytesPerImage: 20, maxTotalBytes: 20 });
    expect(sentIds(projected)).toEqual(["image-2"]);
    expect(projected.filter((message) => message.role === "tool_result" && message.isError)).toEqual([]);
  });

  it("reports a fresh tool image above the active transport byte limit and retains its text and identity", () => {
    const projected = projectSubscriptionImageHistory([toolImage(0, 24)], { maxCount: 5, maxBytesPerImage: 20, maxTotalBytes: 20 });
    expect(sentIds(projected)).toEqual([]);
    expect(projected[0]).toMatchObject({ toolUseId: "image-0", toolName: "view_image", isError: true, content: expect.stringContaining("Loaded image 0") });
  });

  it("preserves an existing error when its older image is omitted", () => {
    const messages: GenericMessage[] = [{ ...toolImage(0), isError: true }, ...imageRounds(6)];
    expect(projectSubscriptionImageHistory(messages, limits)[0]).toMatchObject({ isError: true, content: expect.stringContaining("Loaded image 0") });
  });

  it("rejects authored image input that cannot fit as a whole", () => {
    const messages: GenericMessage[] = [{ role: "user", content: Array.from({ length: 6 }, () => ({
      type: "image" as const, image: `data:image/png;base64,${toolImage(0).image!.data}`,
    })) }];
    expect(() => projectSubscriptionImageHistory(messages, limits)).toThrow("subscription-attachment-too-large");
  });

  it("does not hide malformed images as ordinary capacity eviction", () => {
    const messages = imageRounds(6);
    messages[1] = { ...toolImage(0), image: { data: "invalid", mimeType: "image/png" } };
    expect(() => projectSubscriptionImageHistory(messages, limits)).toThrow("subscription-attachment-not-supported");
  });
});
