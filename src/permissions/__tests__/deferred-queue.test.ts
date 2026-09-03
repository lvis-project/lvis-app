import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inspectFile } from "../../__tests__/test-helpers.js";
import { join } from "node:path";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();

const tmpQueuePath = resources.tmpFilePaths("lvis-deferred-queue-", "deferred-queue.jsonl");

afterEach(async () => {
  await resources.cleanup();
});

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

  it("resolve rewrites the file through temp+rename, never in place", async () => {
    const path = tmpQueuePath();
    const q = new DeferredQueue(path);
    const id = await q.append(SAMPLE);
    const before = statSync(path);
    await q.resolve(id, "approved");
    const after = inspectFile(path);
    // A rename lands a new inode; an in-place write would have kept the old one.
    expect(after.ino).not.toBe(before.ino);
    if (process.platform !== "win32") expect(after.mode).toBe(0o600);
    expect(readdirSync(join(path, ".."))).toEqual(["deferred-queue.jsonl"]);
    const lines = after.text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).status).toBe("approved");
  });

  it("emits pending-count updates on append and resolve", async () => {

    const onPendingChange = vi.fn();
    const q = new DeferredQueue(tmpQueuePath(), onPendingChange);
    const id = await q.append(SAMPLE);
    await q.resolve(id, "approved");
    expect(onPendingChange).toHaveBeenNthCalledWith(1, { pending: 1 });
    expect(onPendingChange).toHaveBeenNthCalledWith(2, { pending: 0 });
  });

  it("records the conversation that raised the entry", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    await q.append({ ...SAMPLE, sessionId: "session-a" });
    expect(q.listPending()[0].sessionId).toBe("session-a");
  });

  it("an entry raised outside a conversation carries no session", async () => {
    const q = new DeferredQueue(tmpQueuePath());
    await q.append(SAMPLE);
    expect(q.listPending()[0].sessionId).toBeUndefined();
  });

  it("announces each appended entry so the host can ask about it", async () => {
    const onEntryPending = vi.fn();
    const q = new DeferredQueue(tmpQueuePath(), undefined, onEntryPending);
    const id = await q.append({ ...SAMPLE, sessionId: "session-a" });
    await q.resolve(id, "approved");
    expect(onEntryPending).toHaveBeenCalledOnce();
    expect(onEntryPending.mock.calls[0][0]).toMatchObject({
      id,
      sessionId: "session-a",
      status: "pending",
    });
  });
});
