import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";
import { PermissionTestResources } from "./test-resources.js";

describe("PermissionTestResources cleanup failures", () => {
  it("settles every flushable and directory before reporting aggregate failures", async () => {
    const flushError = new Error("flush failed");
    const directoryError = new Error("directory cleanup failed");
    let rejectFlush = true;
    let rejectDirectory = true;
    let failedDir = "";
    const cleanupDir = vi.fn(async (dir: string) => {
      if (dir === failedDir && rejectDirectory) {
        rejectDirectory = false;
        throw directoryError;
      }
      await cleanupTmpDir(dir);
    });
    const resources = new PermissionTestResources(cleanupDir);
    failedDir = resources.makeTmpDir("lvis-permission-resources-failed-");
    const cleanedDir = resources.makeTmpDir("lvis-permission-resources-cleaned-");
    const retryingFlush = vi.fn(async () => {
      if (rejectFlush) {
        rejectFlush = false;
        throw flushError;
      }
    });
    const successfulFlush = vi.fn(async () => {});
    resources.trackFlushable({ flush: retryingFlush });
    resources.trackFlushable({ flush: successfulFlush });

    try {
      const error = await resources.cleanup().catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([flushError, directoryError]);
      expect(retryingFlush).toHaveBeenCalledTimes(1);
      expect(successfulFlush).toHaveBeenCalledTimes(1);
      expect(cleanupDir.mock.calls.map(([dir]) => dir)).toEqual([failedDir, cleanedDir]);
      expect(existsSync(failedDir)).toBe(true);
      expect(existsSync(cleanedDir)).toBe(false);

      cleanupDir.mockClear();
      await resources.cleanup();

      expect(retryingFlush).toHaveBeenCalledTimes(2);
      expect(successfulFlush).toHaveBeenCalledTimes(1);
      expect(cleanupDir.mock.calls.map(([dir]) => dir)).toEqual([failedDir, cleanedDir]);
      expect(existsSync(failedDir)).toBe(false);
      expect(existsSync(cleanedDir)).toBe(false);
    } finally {
      rejectFlush = false;
      rejectDirectory = false;
      await resources.cleanup();
    }
  });

  it("retries only failed directories after every flush succeeds", async () => {
    const directoryError = new Error("directory cleanup failed");
    let rejectDirectory = true;
    let failedDir = "";
    const cleanupDir = vi.fn(async (dir: string) => {
      if (dir === failedDir && rejectDirectory) {
        rejectDirectory = false;
        throw directoryError;
      }
      await cleanupTmpDir(dir);
    });
    const resources = new PermissionTestResources(cleanupDir);
    failedDir = resources.makeTmpDir("lvis-permission-resources-retry-");
    const cleanedDir = resources.makeTmpDir("lvis-permission-resources-done-");
    const flush = vi.fn(async () => {});
    resources.trackFlushable({ flush });

    try {
      const error = await resources.cleanup().catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([directoryError]);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(cleanupDir.mock.calls.map(([dir]) => dir)).toEqual([failedDir, cleanedDir]);

      cleanupDir.mockClear();
      await resources.cleanup();

      expect(flush).toHaveBeenCalledTimes(1);
      expect(cleanupDir.mock.calls.map(([dir]) => dir)).toEqual([failedDir]);
      expect(existsSync(failedDir)).toBe(false);
      expect(existsSync(cleanedDir)).toBe(false);
    } finally {
      rejectDirectory = false;
      await resources.cleanup();
    }
  });
});
