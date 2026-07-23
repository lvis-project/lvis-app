import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../memory-manager.js";

describe("MemoryManager boot index verification", () => {
  let lvisDir: string;

  beforeEach(async () => {
    lvisDir = await mkdtemp(join(tmpdir(), "lvis-memory-boot-index-"));
  });

  afterEach(async () => {
    await rm(lvisDir, { recursive: true, force: true });
  });

  it("does not enumerate session JSONL files when the index is healthy and populated", async () => {
    const manager = new MemoryManager({ lvisDir });
    const close = vi.fn();
    const internals = manager as unknown as {
      searchIndex: {
        open(): boolean;
        rowCount(): number;
        close(): void;
      };
      listSessionJsonlFiles(): string[];
    };
    internals.searchIndex = {
      open: vi.fn(() => true),
      rowCount: vi.fn(() => 3),
      close,
    };
    const listSessionJsonlFiles = vi.fn(() => {
      throw new Error("healthy index must not scan the sessions directory");
    });
    internals.listSessionJsonlFiles = listSessionJsonlFiles;

    await expect(manager.verifyOrRebuildSearchIndex()).resolves.toBeUndefined();

    expect(listSessionJsonlFiles).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
