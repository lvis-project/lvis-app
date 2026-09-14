import { z } from "zod";

/** Host resource ceilings, independent of any transport's attachment budget. */
export const IMAGE_PREPARATION_POLICY = Object.freeze({
  maxInputBytes: 25 * 1024 * 1024,
  // A single four-channel, eight-bit raster at this ceiling is 64 MiB.
  // Decoder intermediates and native allocations are additional, not an RSS cap.
  maxInputPixels: 16 * 1024 * 1024,
  maxInputChannels: 4,
  maxOutputBytes: 5 * 1024 * 1024,
  defaultMaxDimension: 2048,
  maxDimension: 4096,
  concurrentJobs: 1,
  queuedJobs: 8,
  readChunkBytes: 64 * 1024,
  maxResponseMetadataBytes: 4096,
  maxEncodeAttempts: 13,
});

export const ImagePreparationOptionsSchema = z.object({
  maxBytes: z.number().int().min(1).max(IMAGE_PREPARATION_POLICY.maxOutputBytes)
    .default(IMAGE_PREPARATION_POLICY.maxOutputBytes),
  maxDimension: z.number().int().min(1).max(IMAGE_PREPARATION_POLICY.maxDimension)
    .default(IMAGE_PREPARATION_POLICY.defaultMaxDimension),
}).strict();

export type ImagePreparationOptions = z.infer<typeof ImagePreparationOptionsSchema>;

const ImageReadScopeSchema = z.object({
  cwd: z.string().min(1),
  extraAllowedDirectories: z.array(z.string().min(1)),
  blockReadsOutsideWorkingDirectories: z.boolean(),
}).strict();
export type ImageReadScope = z.input<typeof ImageReadScopeSchema>;

export const ImagePreparationRequestSchema = z.object({
  path: z.string().min(1),
  options: ImagePreparationOptionsSchema,
  scope: ImageReadScopeSchema,
}).strict();
export type ImagePreparationRequest = z.infer<typeof ImagePreparationRequestSchema>;

export const PreparedImageSchema = z.object({
  data: z.string().max(4 * Math.ceil(IMAGE_PREPARATION_POLICY.maxOutputBytes / 3)),
  mimeType: z.literal("image/png"),
  bytes: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxOutputBytes),
  width: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxDimension),
  height: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxDimension),
  originalWidth: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxInputPixels),
  originalHeight: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxInputPixels),
  originalFormat: z.enum(["png", "jpeg", "gif", "webp"]),
  inputBytes: z.number().int().positive().max(IMAGE_PREPARATION_POLICY.maxInputBytes),
  frame: z.literal(0),
  frameCount: z.number().int().positive(),
  orientationApplied: z.boolean(),
  resized: z.boolean(),
}).strict();

export type PreparedImage = z.infer<typeof PreparedImageSchema>;
