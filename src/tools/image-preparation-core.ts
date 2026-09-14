import sharp from "sharp";
import {
  IMAGE_PREPARATION_POLICY,
  ImagePreparationOptionsSchema,
  type ImagePreparationOptions,
  type PreparedImage,
} from "../shared/image-preparation-policy.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { requireSupportedImage } from "./image-preparation-input.js";

/** Runs only in the owned decoder process; no native work enters the host loop. */
export async function normalizeImage(bytes: Buffer, requested: ImagePreparationOptions): Promise<PreparedImage> {
  const options = ImagePreparationOptionsSchema.parse(requested);
  if (bytes.length > IMAGE_PREPARATION_POLICY.maxInputBytes) throw new Error("image-input-limit: Source file exceeds the host read limit. Export a smaller source image first.");
  const originalFormat = requireSupportedImage(bytes);
  sharp.cache(false);
  sharp.concurrency(1);
  const decoderOptions = {
    failOn: "warning" as const,
    limitInputPixels: IMAGE_PREPARATION_POLICY.maxInputPixels,
    limitInputChannels: IMAGE_PREPARATION_POLICY.maxInputChannels,
    unlimited: false,
    sequentialRead: true,
    page: 0,
    pages: 1,
    animated: false,
  };
  const metadata = await sharp(bytes, decoderOptions).metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.pageHeight ?? metadata.height;
  if (metadata.format !== originalFormat || !originalWidth || !originalHeight ||
      originalWidth * originalHeight > IMAGE_PREPARATION_POLICY.maxInputPixels ||
      !metadata.channels || metadata.channels > IMAGE_PREPARATION_POLICY.maxInputChannels) {
    throw new Error("image-pixel-limit: Invalid dimensions, channels, or image exceeds the host pixel limit. Export a smaller source image first.");
  }
  const orientationApplied = metadata.orientation !== undefined && metadata.orientation !== 1;
  const swapsDimensions = metadata.orientation !== undefined && metadata.orientation >= 5;
  const orientedWidth = swapsDimensions ? originalHeight : originalWidth;
  const orientedHeight = swapsDimensions ? originalWidth : originalHeight;
  let dimension = Math.min(options.maxDimension, Math.max(orientedWidth, orientedHeight));
  for (let attempt = 0; attempt < IMAGE_PREPARATION_POLICY.maxEncodeAttempts; attempt++) {
    // PNG preserves transparency and avoids introducing lossy encoding artifacts.
    // This fully decodes the selected frame; metadata inspection alone is not validation.
    const { data, info } = await sharp(bytes, decoderOptions).autoOrient()
      .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
      .png().timeout({ seconds: Math.ceil(TOOL_TIMEOUT_POLICY.imagePreparationMs / 1000) })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= options.maxBytes) {
      return {
        data: data.toString("base64"), mimeType: "image/png", bytes: data.length,
        width: info.width, height: info.height, originalWidth, originalHeight,
        originalFormat, inputBytes: bytes.length, frame: 0, frameCount: metadata.pages ?? 1,
        orientationApplied, resized: info.width !== orientedWidth || info.height !== orientedHeight,
      };
    }
    if (dimension === 1) break;
    dimension = Math.max(1, Math.floor(dimension / 2));
  }
  throw new Error(`image-output-limit: Cannot encode an image within maxBytes=${options.maxBytes}. Request a larger maxBytes value within the host limit.`);
}
