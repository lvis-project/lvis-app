/** Browser-safe source of truth for composer image inputs. */
export const MAX_COMPOSER_ATTACHMENT_COUNT = 5;
export const MAX_COMPOSER_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_COMPOSER_IMAGE_BASE64_CHARS = Math.ceil(MAX_COMPOSER_IMAGE_BYTES / 3) * 4;

export interface ComposerImageFormat {
  readonly extension: string;
  readonly mimeType: string;
}

const PNG_FORMAT = Object.freeze({ extension: "png", mimeType: "image/png" } satisfies ComposerImageFormat);
const JPEG_FORMAT = Object.freeze({ extension: "jpg", mimeType: "image/jpeg" } satisfies ComposerImageFormat);
const GIF_FORMAT = Object.freeze({ extension: "gif", mimeType: "image/gif" } satisfies ComposerImageFormat);
const WEBP_FORMAT = Object.freeze({ extension: "webp", mimeType: "image/webp" } satisfies ComposerImageFormat);
const BMP_FORMAT = Object.freeze({ extension: "bmp", mimeType: "image/bmp" } satisfies ComposerImageFormat);

/** Canonical PNG descriptor for picker paths that intentionally retain PNG fallback. */
export const COMPOSER_IMAGE_PNG_FORMAT = PNG_FORMAT;

const FORMAT_BY_EXTENSION = new Map<string, ComposerImageFormat>([
  ["png", PNG_FORMAT], ["jpg", JPEG_FORMAT], ["jpeg", JPEG_FORMAT], ["gif", GIF_FORMAT], ["webp", WEBP_FORMAT], ["bmp", BMP_FORMAT],
]);
const FORMAT_BY_MIME_TYPE = new Map<string, ComposerImageFormat>([
  [PNG_FORMAT.mimeType, PNG_FORMAT], [JPEG_FORMAT.mimeType, JPEG_FORMAT], [GIF_FORMAT.mimeType, GIF_FORMAT], [WEBP_FORMAT.mimeType, WEBP_FORMAT], [BMP_FORMAT.mimeType, BMP_FORMAT],
]);
const MAX_COMPOSER_IMAGE_DATA_URL_PREFIX_CHARS = Math.max(...[...FORMAT_BY_MIME_TYPE.keys()].map((mimeType) => `data:${mimeType};base64,`.length));
export const MAX_COMPOSER_IMAGE_DATA_URL_CHARS = MAX_COMPOSER_IMAGE_DATA_URL_PREFIX_CHARS + MAX_COMPOSER_IMAGE_BASE64_CHARS;

/** Callers normalize extensions and MIME types before lookup. */
export function isComposerImageExtension(extension: string): boolean {
  return FORMAT_BY_EXTENSION.has(extension);
}
export function composerImageFormatForExtension(extension: string): ComposerImageFormat | undefined {
  return FORMAT_BY_EXTENSION.get(extension);
}
export function composerImageFormatForMimeType(mimeType: string): ComposerImageFormat | undefined {
  return FORMAT_BY_MIME_TYPE.get(mimeType);
}
export function composerImageMimeForExtension(extension: string): string | undefined {
  return composerImageFormatForExtension(extension)?.mimeType;
}

/** Strict magic sniff; picker fallback behavior stays with its caller. */
export function sniffComposerImageFormat(bytes: Uint8Array): ComposerImageFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return PNG_FORMAT;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return JPEG_FORMAT;
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return GIF_FORMAT;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return WEBP_FORMAT;
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return BMP_FORMAT;
  return null;
}
