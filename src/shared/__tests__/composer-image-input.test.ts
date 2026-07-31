import { describe, expect, it } from "vitest";

import {
  COMPOSER_IMAGE_PNG_FORMAT,
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_COMPOSER_IMAGE_BASE64_CHARS,
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_COMPOSER_IMAGE_DATA_URL_CHARS,
  composerImageFormatForExtension,
  composerImageFormatForMimeType,
  isComposerImageExtension,
  sniffComposerImageFormat,
} from "../composer-image-input.js";

describe("composer image input source of truth", () => {
  it("keeps the picker count and encoded limits derived from the image byte cap", () => {
    expect(MAX_COMPOSER_ATTACHMENT_COUNT).toBe(5);
    expect(MAX_COMPOSER_IMAGE_BASE64_CHARS).toBe(Math.ceil(MAX_COMPOSER_IMAGE_BYTES / 3) * 4);
    expect(MAX_COMPOSER_IMAGE_DATA_URL_CHARS).toBeGreaterThan(MAX_COMPOSER_IMAGE_BASE64_CHARS);
  });

  it.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["bmp", "image/bmp"],
  ])("maps the supported %s extension", (extension, mimeType) => {
    expect(isComposerImageExtension(extension)).toBe(true);
    expect(composerImageFormatForExtension(extension)).toMatchObject({ mimeType });
  });

  it("does not broaden the normalized extension and MIME allowlists", () => {
    expect(isComposerImageExtension("PNG")).toBe(false);
    expect(isComposerImageExtension("svg")).toBe(false);
    expect(composerImageFormatForExtension("svg")).toBeUndefined();
    expect(composerImageFormatForMimeType("image/svg+xml")).toBeUndefined();
    expect(composerImageFormatForMimeType("image/jpeg")).toMatchObject({ extension: "jpg" });
  });

  it.each([
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    [[0x42, 0x4d], "image/bmp"],
  ])("strictly sniffs supported magic bytes", (bytes, mimeType) => {
    expect(sniffComposerImageFormat(new Uint8Array(bytes))).toMatchObject({ mimeType });
  });

  it("returns null for incomplete or unknown signatures so strict transports can fail closed", () => {
    expect(sniffComposerImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffComposerImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBeNull();
    expect(sniffComposerImageFormat(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    expect(COMPOSER_IMAGE_PNG_FORMAT).toEqual({ extension: "png", mimeType: "image/png" });
  });
});
