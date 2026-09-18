import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { buildImagePreparationEntry, imageFixturePath } from "../../__tests__/support/image-preparation-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { buildMainBoundaryBundle, childBundleDir, repositoryRoot } from "../../plugins/isolation/__tests__/child-entry-bundle.js";
import { IMAGE_PREPARATION_POLICY, ImagePreparationOptionsSchema, ImagePreparationRequestSchema, type ImagePreparationOptions } from "../../shared/image-preparation-policy.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import * as managed from "../../main/managed-child-processes.js";
import { projectSubscriptionImageHistory } from "../../main/subscription-image-history.js";
import { MAX_ACP_SUBSCRIPTION_IMAGE_BYTES } from "../../main/acp-subscription-session-client.js";
import type { GenericMessage } from "../../engine/llm/types.js";

const runtime = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../main/main-paths.js", async (original) => ({
  ...await original<typeof import("../../main/main-paths.js")>(),
  get mainDir() { return runtime.directory; },
}));
import { prepareImageBytes, prepareImageFile } from "../image-preparation.js";
import { normalizeImage } from "../image-preparation-core.js";

function prepareFixtureImage(path: string, options: Partial<ImagePreparationOptions> = {}, signal?: AbortSignal) {
  return prepareImageFile(path, { cwd: repositoryRoot(), extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true }, options, signal);
}

let directory: string;
function observeNextImageChild(): Promise<ChildProcess> {
  const original = managed.spawnManaged;
  return new Promise((resolve) => {
    vi.spyOn(managed, "spawnManaged").mockImplementationOnce((...args) => {
      const child = original(...args); resolve(child); return child;
    });
  });
}

async function useStalledImageRuntime(): Promise<void> {
  const stalled = join(directory, "stalled"); await mkdir(stalled, { recursive: true });
  await writeFile(join(stalled, "image-preparation-child.js"), "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  runtime.directory = stalled;
}
beforeAll(async () => {
  directory = await buildImagePreparationEntry("image-preparation-runtime");
  runtime.directory = directory;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); runtime.directory = directory; });
afterAll(async () => { await cleanupTmpDir(directory); });

describe("bounded image preparation", () => {
  it("normalizes broker-returned bytes through the isolated decoder stdin", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const source = await readFile(imageFixturePath(`grid.${format}`));
      const result = await prepareImageBytes(source, { maxDimension: 4 });
      expect(result).toMatchObject({
        originalFormat: format,
        width: 4,
        height: 2,
        inputBytes: source.byteLength,
      });
      expect((await sharp(Buffer.from(result.data, "base64")).metadata()).format).toBe("png");
    }
  });

  it("copies broker-returned bytes before admission and rejects oversized input before spawning", async () => {
    const source = await readFile(imageFixturePath("grid.png"));
    const expectedBytes = source.byteLength;
    const prepared = prepareImageBytes(source, { maxDimension: 2 });
    source.fill(0);
    expect(await prepared).toMatchObject({ width: 2, inputBytes: expectedBytes });

    const spawn = vi.spyOn(managed, "spawnManaged");
    await expect(prepareImageBytes(Buffer.alloc(IMAGE_PREPARATION_POLICY.maxInputBytes + 1)))
      .rejects.toThrow("image-input-limit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fully decodes each supported source format in a child and preserves transparency", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const result = await prepareFixtureImage(imageFixturePath(`grid.${format}`), { maxDimension: 4 });
      const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info).toMatchObject({ width: 4, height: 2 });
      expect(result.originalFormat).toBe(format);
      if (format === "png") expect(decoded.info.channels).toBe(4);
    }
  });

  it("corrects EXIF orientation and reports original and displayed dimensions", async () => {
    const result = await prepareFixtureImage(imageFixturePath("oriented.jpeg"));
    expect(result).toMatchObject({ originalWidth: 8, originalHeight: 4, width: 4, height: 8, orientationApplied: true, resized: false });
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).orientation).toBeUndefined();
  });

  it("reports selecting the first frame without stacking animated frames", async () => {
    const result = await prepareFixtureImage(imageFixturePath("animated.gif"));
    expect(result).toMatchObject({ frame: 0, frameCount: 2, width: 8, height: 4 });
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).pages).toBeUndefined();
  });

  it("fits a caller byte budget by reducing dimensions and errors when even one pixel cannot fit", async () => {
    const result = await prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 100 });
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(result.resized).toBe(true);
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).width).toBe(result.width);
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 1 })).rejects.toThrow("image-output-limit");
  });

  it("rejects an input pixel bomb before producing an image", async () => {
    const source = await sharp({ create: { width: 4096, height: 4097, channels: 3, background: "red" } }).png().toBuffer();
    expect(source.length).toBeLessThan(IMAGE_PREPARATION_POLICY.maxInputBytes);
    await expect(normalizeImage(source, ImagePreparationOptionsSchema.parse({}))).rejects.toThrow(/pixel/i);
  });

  it("rejects corruption after a valid format header", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const source = await readFile(imageFixturePath(`grid.${format}`));
      await expect(normalizeImage(source.subarray(0, 16), ImagePreparationOptionsSchema.parse({}))).rejects.toThrow();
    }
  });

  it("rejects caller attempts to raise host ceilings", () => {
    expect(ImagePreparationOptionsSchema.safeParse({ maxBytes: IMAGE_PREPARATION_POLICY.maxOutputBytes + 1 }).success).toBe(false);
    expect(ImagePreparationOptionsSchema.safeParse({ maxDimension: IMAGE_PREPARATION_POLICY.maxDimension + 1 }).success).toBe(false);
    expect(ImagePreparationRequestSchema.safeParse({ path: imageFixturePath("grid.png"), options: {} }).success).toBe(false);
  });

  it("rechecks the frozen invocation read scope inside the decoder process", async () => {
    const path = imageFixturePath("grid.png");
    await expect(prepareImageFile(path, {
      cwd: directory, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true,
    })).rejects.toThrow("Sandbox");
    const extraAllowedDirectories = [dirname(path)];
    const admitted = prepareImageFile(path, {
      cwd: directory, extraAllowedDirectories, blockReadsOutsideWorkingDirectories: true,
    });
    extraAllowedDirectories.length = 0;
    expect((await admitted).width).toBe(8);
  });

  it("recovers from an active transport delivery limit by requesting a smaller real image", async () => {
    const pixels = Buffer.alloc(512 * 512 * 3);
    let state = 17;
    for (let index = 0; index < pixels.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      pixels[index] = state & 255;
    }
    const path = join(directory, "detailed.png");
    await writeFile(path, await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer());
    const limits = { maxCount: 1, maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES, maxTotalBytes: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES };
    const initial = await prepareFixtureImage(path);
    const message: GenericMessage = { role: "tool_result", toolUseId: "first-image", toolName: "view_image", content: "Loaded image", image: initial };
    expect(initial.bytes).toBeGreaterThan(limits.maxBytesPerImage);
    expect(projectSubscriptionImageHistory([message], limits)[0]).toMatchObject({ isError: true, content: expect.stringContaining("Image delivery failed") });
    const retry = await prepareFixtureImage(path, { maxBytes: limits.maxBytesPerImage });
    const delivered = projectSubscriptionImageHistory([{ ...message, toolUseId: "smaller-image", image: retry }], limits);
    expect(delivered[0]).toMatchObject({ image: { data: retry.data } });
    expect(delivered[0]).not.toHaveProperty("isError");
    expect((await sharp(Buffer.from(retry.data, "base64")).raw().toBuffer({ resolveWithObject: true })).info.width).toBe(retry.width);
    expect(message.image).toBe(initial);
  });

  it("does not start a child for an already cancelled request", async () => {
    const spawn = vi.spyOn(managed, "spawnManaged");
    const controller = new AbortController(); controller.abort();
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal)).rejects.toThrow("image-cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("waits for child termination on cancellation, then admits a queued request", async () => {
    const ready = observeNextImageChild();
    const controller = new AbortController();
    const first = prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal);
    const rejection = expect(first).rejects.toThrow("image-cancelled");
    const firstChild = await ready;
    const second = prepareFixtureImage(imageFixturePath("grid.png"), { maxDimension: 2 });
    controller.abort();
    await rejection;
    expect(firstChild.exitCode !== null || firstChild.signalCode !== null).toBe(true);
    expect((await second).width).toBe(2);
  });

  it("includes native processing in the total deadline and reclaims the child", async () => {
    await useStalledImageRuntime();
    const ready = observeNextImageChild();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = prepareFixtureImage(imageFixturePath("grid.png"));
    const rejection = expect(request).rejects.toThrow("image-processing-timeout");
    const child = await ready;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.imagePreparationMs);
    await rejection;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("bounds the waiting queue and removes cancelled requests before reading or spawning", async () => {
    await useStalledImageRuntime();
    const ready = observeNextImageChild();
    const controller = new AbortController();
    const first = prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal).catch((error: Error) => error.message);
    await ready;
    const controllers = Array.from({ length: IMAGE_PREPARATION_POLICY.queuedJobs }, () => new AbortController());
    const queued = controllers.map((item) => prepareFixtureImage("must-not-be-read.png", {}, item.signal).catch((error: Error) => error.message));
    await expect(prepareFixtureImage(imageFixturePath("grid.png"))).rejects.toThrow("image-busy");
    for (const item of controllers) item.abort();
    expect(await Promise.all(queued)).toEqual(controllers.map(() => "image-cancelled: Image preparation was cancelled."));
    controller.abort();
    expect(await first).toContain("image-cancelled");
  });

  it("reports a missing decoder installation and releases admission for the next request", async () => {
    runtime.directory = join(directory, "missing");
    await expect(prepareFixtureImage(imageFixturePath("grid.png"))).rejects.toThrow("image-processing-unavailable");
    runtime.directory = directory;
    expect((await prepareFixtureImage(imageFixturePath("grid.png"))).width).toBe(8);
  });

  it("rejects an oversized child response without keeping the process alive", async () => {
    const excessive = join(directory, "excessive"); await mkdir(excessive, { recursive: true });
    await writeFile(join(excessive, "image-preparation-child.js"), "process.stdin.resume(); process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);\n");
    runtime.directory = excessive;
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 1 })).rejects.toThrow("image-response-limit");
  });

  it("runs the complete file-to-decoder flow under the standalone runtime", async () => {
    const outdir = childBundleDir("image-preparation-standalone");
    try {
      await buildMainBoundaryBundle({ entryPoints: { "image-client": join(repositoryRoot(), "src/tools/image-preparation.ts") }, outdir, splitting: true });
      await buildImagePreparationEntry("image-preparation-standalone");
      const node = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
      const result = spawnSync(node, ["--input-type=module", "-e", `
        import { prepareImageFile } from ${JSON.stringify(pathToFileURL(join(outdir, "image-client.mjs")).href)};
        const image = await prepareImageFile(process.argv[1], { cwd: process.argv[2], extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true }, { maxDimension: 2, maxBytes: 512 });
        process.stdout.write(JSON.stringify({ image, electron: process.versions.electron ?? null }));
      `, imageFixturePath("grid.png"), repositoryRoot()], { encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.imagePreparationMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.electron).toBeNull();
      expect(response.image).toMatchObject({ width: 2, height: 1 });
    } finally { await cleanupTmpDir(outdir); }
  });
});
