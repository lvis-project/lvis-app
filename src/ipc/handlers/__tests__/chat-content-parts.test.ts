import { describe, expect, it } from "vitest";

import {
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_COMPOSER_IMAGE_DATA_URL_CHARS,
} from "../../../shared/composer-image-input.js";
import { MAX_LOCAL_USER_CONTENT_PARTS } from "../../../main/subscription-attachment-input.js";
import { MCP_RESOURCE_ATTACHMENTS_PER_TURN } from "../../../shared/mcp-resource-bounds.js";
import { validateUserContentParts } from "../chat.js";

const VALID_PNG_BASE64 = "iVBORw0KGgo=";
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;
const VALID_TEXT_BASE64 = "SGVsbG8=";
const VALID_TEXT_DATA_URL = `data:text/plain;base64,${VALID_TEXT_BASE64}`;

const image = (data: string, mimeType = "image/png") => ({
  type: "image",
  image: data,
  mimeType,
});

const file = (data: string, mimeType = "text/plain") => ({
  type: "file",
  data,
  mimeType,
});

describe("validateUserContentParts attachment IPC boundary", () => {
  it("keeps only the picker-cap number of binary parts while preserving text", () => {
    const images = Array.from(
      { length: MAX_COMPOSER_ATTACHMENT_COUNT - 1 },
      () => image(VALID_PNG_DATA_URL),
    );
    const textBefore = { type: "text", text: "before" };
    const localFile = file(VALID_TEXT_DATA_URL);
    const droppedImage = image(VALID_PNG_DATA_URL);
    const textAfter = { type: "text", text: "after" };

    expect(validateUserContentParts([
      textBefore,
      ...images,
      localFile,
      droppedImage,
      textAfter,
    ])).toEqual([
      textBefore,
      ...images,
      localFile,
      textAfter,
    ]);
  });
  it("accepts the shared maximum of one text, five binary, and eight resource parts", () => {
    const binary = Array.from(
      { length: MAX_COMPOSER_ATTACHMENT_COUNT },
      () => image(VALID_PNG_DATA_URL),
    );
    const resourceText = Array.from(
      { length: MCP_RESOURCE_ATTACHMENTS_PER_TURN },
      (_, index) => ({ type: "text" as const, text: `resource ${index}` }),
    );
    const content = [
      { type: "text" as const, text: "user note" },
      ...binary,
      ...resourceText,
    ];

    expect(content).toHaveLength(MAX_LOCAL_USER_CONTENT_PARTS);
    expect(validateUserContentParts(content)).toEqual(content);
  });

  it("accepts verified local data URLs and projects their MIME types canonically", () => {
    expect(validateUserContentParts([
      image(`data:IMAGE/PNG;base64,${VALID_PNG_BASE64}`, "IMAGE/PNG"),
      file(`data:TEXT/PLAIN;base64,${VALID_TEXT_BASE64}`, "TEXT/PLAIN"),
    ])).toEqual([
      image(VALID_PNG_DATA_URL),
      file(VALID_TEXT_DATA_URL),
    ]);
  });

  it("preserves normalized image dimensions for provider-wire token estimation", () => {
    const value = {
      type: "image" as const,
      image: VALID_PNG_DATA_URL,
      mimeType: "image/png",
      width: 2048,
      height: 512,
    };

    expect(validateUserContentParts([value])).toEqual([value]);
  });
  it("rejects URL-shaped, malformed/noncanonical, and mismatched binary data", () => {
    expect(validateUserContentParts([
      image("https://attacker.example/image.png"),
      image(`data:image/png;base64,${VALID_PNG_BASE64}\n`),
      image("data:image/png;base64,c2VjcmV0"),
      image(VALID_PNG_DATA_URL),
      file(VALID_TEXT_DATA_URL),
    ])).toEqual([
      image(VALID_PNG_DATA_URL),
      file(VALID_TEXT_DATA_URL),
    ]);

    expect(validateUserContentParts([
      image(VALID_PNG_DATA_URL, "image/jpeg"),
      file("https://attacker.example/document.txt"),
      file(`data:text/plain;base64,${VALID_TEXT_BASE64}\n`),
      file(VALID_TEXT_DATA_URL, "application/pdf"),
      file(VALID_TEXT_DATA_URL),
    ])).toEqual([
      file(VALID_TEXT_DATA_URL),
    ]);
  });

  it("caps malformed binary candidates before inspecting later payload data", () => {
    const oversized = image("x".repeat(MAX_COMPOSER_IMAGE_DATA_URL_CHARS + 1));
    const malformed = Array.from(
      { length: MAX_COMPOSER_ATTACHMENT_COUNT - 1 },
      () => file("not-a-data-url"),
    );
    const unreadAfterCap = {
      type: "file",
      get data(): string {
        throw new Error("binary candidate beyond the cap must not be read");
      },
      mimeType: "text/plain",
    };
    const laterValidImage = image(VALID_PNG_DATA_URL);
    const text = { type: "text", text: "still accepted" };

    expect(validateUserContentParts([
      oversized,
      ...malformed,
      unreadAfterCap,
      laterValidImage,
      text,
    ])).toEqual([text]);
  });

  it("rejects oversized sparse arrays before inspecting any part", () => {
    const oversized = new Array<unknown>(MAX_LOCAL_USER_CONTENT_PARTS + 1);
    Object.defineProperty(oversized, 0, {
      get(): never {
        throw new Error("oversized sparse input must not be traversed");
      },
    });

    expect(validateUserContentParts(oversized)).toBeUndefined();
  });

  it("drops accessor-backed parts without destabilizing the input boundary", () => {
    const safe = { type: "text", text: "keep" };
    const accessorBacked = {
      get type(): never {
        throw new Error("untrusted getter must not escape the boundary");
      },
    };

    expect(validateUserContentParts([safe, accessorBacked])).toEqual([safe]);
  });
});
