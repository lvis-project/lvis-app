import { join } from "node:path";
import { mainDir } from "../main/main-paths.js";
import { spawnManaged, forceKillManagedChildProcess } from "../main/managed-child-processes.js";
import { buildSafeChildEnv } from "./safe-env.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  IMAGE_PREPARATION_POLICY, ImagePreparationRequestSchema, PreparedImageSchema,
  type ImagePreparationOptions, type ImagePreparationRequest, type ImageReadScope, type PreparedImage,
} from "../shared/image-preparation-policy.js";

type ImageAdmission = { grant: () => void };
const pending: ImageAdmission[] = [];
let active = 0;

async function acquireImageSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (active >= IMAGE_PREPARATION_POLICY.concurrentJobs) {
    if (pending.length >= IMAGE_PREPARATION_POLICY.queuedJobs) throw new Error("image-busy: Image preparation queue is full. Retry after the current image calls finish.");
    await new Promise<void>((resolve, reject) => {
      const admission: ImageAdmission = { grant: () => {
        signal.removeEventListener("abort", abort);
        resolve();
      } };
      const abort = (): void => {
        const index = pending.indexOf(admission);
        if (index >= 0) pending.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.push(admission);
    });
  } else {
    active++;
  }
  return () => {
    const next = pending.shift();
    if (next) next.grant();
    else active--;
  };
}

/** Resolve only after child closure, including cancellation and malformed output. */
function runImageChild(request: ImagePreparationRequest, signal: AbortSignal): Promise<PreparedImage> {
  signal.throwIfAborted();
  const { options } = request;
  const child = spawnManaged(process.execPath, [join(mainDir, "image-preparation-child.js"), JSON.stringify(request)], {
    env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }, { label: "image-preparation" });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const maxWireBytes = 4 * Math.ceil(options.maxBytes / 3) + IMAGE_PREPARATION_POLICY.maxResponseMetadataBytes;
    let total = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      forceKillManagedChildProcess(child, "image-preparation-stop");
    };
    const abort = (): void => stop(signal.reason instanceof Error ? signal.reason : new Error("image-cancelled: Image preparation was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      total += chunk.length;
      if (total > maxWireBytes) stop(new Error("image-response-limit: Decoder response exceeds its byte budget."));
      else chunks.push(chunk);
    });
    // Drain diagnostics without retaining source-dependent or unbounded text.
    child.stderr!.resume();
    child.once("error", (error) => {
      failure = new Error(`image-processing-unavailable: ${error.message}`);
      if (child.pid) stop(failure);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      try {
        if (total === 0) throw new Error(`image-processing-unavailable: Decoder exited without a response (exit ${code}). Repair the installed image runtime before retrying.`);
        const response: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
        if (typeof response !== "object" || response === null || !("ok" in response)) throw new Error("Malformed decoder response");
        if (response.ok === false && "error" in response && typeof response.error === "string") throw new Error(response.error);
        if (code !== 0 || response.ok !== true || !("image" in response)) throw new Error("Decoder exited without a valid image");
        const image = PreparedImageSchema.parse(response.image);
        const decoded = Buffer.from(image.data, "base64");
        if (image.bytes !== decoded.length || image.bytes > options.maxBytes ||
            image.data !== decoded.toString("base64") || image.width > options.maxDimension || image.height > options.maxDimension ||
            image.originalWidth * image.originalHeight > IMAGE_PREPARATION_POLICY.maxInputPixels) {
          throw new Error("Decoder result violates the image preparation limits");
        }
        resolve(image);
      } catch (error) {
        reject(error);
      }
    });
    if (signal.aborted) abort();
  });
}

export async function prepareImageFile(
  path: string,
  readScope: ImageReadScope,
  requested: Partial<ImagePreparationOptions> = {},
  callerSignal?: AbortSignal,
): Promise<PreparedImage> {
  // Parsing copies the scope/options before admission; callers cannot mutate a queued request.
  const request = ImagePreparationRequestSchema.parse({ path, options: requested, scope: readScope });
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("image-cancelled: Image preparation was cancelled."));
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("image-processing-timeout: Image preparation exceeded its total deadline. Try a smaller source image.")), TOOL_TIMEOUT_POLICY.imagePreparationMs);
  let release: (() => void) | undefined;
  try {
    release = await acquireImageSlot(controller.signal);
    return await runImageChild(request, controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
    release?.();
  }
}
