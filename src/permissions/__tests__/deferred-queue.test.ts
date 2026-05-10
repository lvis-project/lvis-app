import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredQueue } from "../reviewer/deferred-queue.js";

function tmpQueuePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-deferred-queue-"));
  return join(dir, "deferred-queue.jsonl");
}

const SAMPLE = {
  toolName: "fs_write",
  source: "builtin" as const,
  category: "write" as const,
  inputSummary: '{"path":"<redacted>"}',
  verdict: { level: "high" as const, reason: "test" },
};

describe("DeferredQueue", () => {
  it("append + listPending round-trip", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    expect(q.listPending()).toEqual([]);
    const id = await q.append(SAMPLE);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const pending = q.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].status).toBe("pending");
  });

  it("size includes resolved entries", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    const id = await q.append(SAMPLE);
    await q.resolve(id, "approved");
    expect(q.listPending()).toHaveLength(0);
    expect(q.size()).toBe(1);
  });

  it("resolve sets status + resolvedAt + reason", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    const id = await q.append(SAMPLE);
    const resolved = await q.resolve(id, "rejected", "user denied after review");
    expect(resolved?.status).toBe("rejected");
    expect(resolved?.resolutionReason).toBe("user denied after review");
    expect(resolved?.resolvedAt).toBeTruthy();
  });

  it("resolve is idempotent — second call returns the existing resolved entry", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    const id = await q.append(SAMPLE);
    await q.resolve(id, "approved");
    const second = await q.resolve(id, "rejected");
    // Idempotent: status stays approved (not rejected)
    expect(second?.status).toBe("approved");
  });

  it("resolve returns null for unknown id", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    const r = await q.resolve("nonexistent", "approved");
    expect(r).toBeNull();
  });

  it("entries persist across instances", async () => {
    const path = tmpQueuePath();
    const firstQueue = new DeferredQueue(path);
    const id = await firstQueue.append(SAMPLE);
    await firstQueue.resolve(id, "approved");
    const secondQueue = new DeferredQueue(path);
    expect(secondQueue.size()).toBe(1);
    expect(secondQueue.listPending()).toHaveLength(0);
  });

  it("file format is JSONL", async () => {
    const path = tmpQueuePath();
    const q = new DeferredQueue(path);
    await q.append(SAMPLE);
    await q.append({ ...SAMPLE, toolName: "shell_run", category: "shell" });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("toolName");
      expect(parsed).toHaveProperty("status");
    }
  });

  it("emits pending-count updates on append and resolve", async () => {
    const onPendingChange = vi.fn();
    const q = new DeferredQueue(tmpQueuePath(), onPendingChange);
    const id = await q.append(SAMPLE);
    await q.resolve(id, "approved");
    expect(onPendingChange).toHaveBeenNthCalledWith(1, { pending: 1 });
    expect(onPendingChange).toHaveBeenNthCalledWith(2, { pending: 0 });
  });
});
