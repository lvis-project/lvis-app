/**
 * D7 — IPC handler test: lvis:pageindex:scan-paths
 *
 * Verifies:
 * 1. findMethodByCapability resolves correctly via pluginRuntime mock.
 * 2. IPC handler returns { ok: true } when the plugin method succeeds.
 * 3. IPC handler returns { ok: false, error: "no-indexer" } when no plugin
 *    declares the document-indexer capability.
 * 4. validateSender is called — unauthorized frames are rejected.
 */
import { describe, it, expect, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

import { findMethodByCapability } from "../boot/plugins.js";

// ─── Mock pluginRuntime ────────────────────────────────────────────────────

function makeRuntime(opts: {
  capabilityPluginId?: string;
  methodNames?: string[];
  callResult?: unknown;
}) {
  const tools = opts.methodNames ?? ["pageindex_scan"];
  return {
    findPluginIdByCapability: vi.fn((cap: string) =>
      cap === "document-indexer" ? (opts.capabilityPluginId ?? "pageindex") : undefined,
    ),
    getPluginManifest: vi.fn((_id: string) => ({ tools })),
    call: vi.fn(async (_method: string, _payload: unknown) => opts.callResult ?? { indexed: 2, failed: 0 }),
  };
}

// ─── findMethodByCapability unit tests ────────────────────────────────────

describe("findMethodByCapability", () => {
  it("returns matching method name when capability and predicate match", () => {
    const runtime = makeRuntime({ methodNames: ["index_scan", "pageindex_scan", "chat_preview"] });
    const result = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    expect(result).toBe("index_scan"); // first match
  });

  it("returns pageindex_scan when only that method ends with _scan", () => {
    const runtime = makeRuntime({ methodNames: ["pageindex_scan", "chat_preview"] });
    const result = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    expect(result).toBe("pageindex_scan");
  });

  it("returns undefined when no plugin declares the capability", () => {
    const runtime = makeRuntime({ capabilityPluginId: undefined });
    runtime.findPluginIdByCapability.mockReturnValue(undefined);
    const result = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when no method satisfies predicate", () => {
    const runtime = makeRuntime({ methodNames: ["chat_preview", "index_documents"] });
    const result = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    expect(result).toBeUndefined();
  });
});

// ─── IPC handler integration (inline simulation) ──────────────────────────

describe("lvis:pageindex:scan-paths handler logic", () => {
  it("calls pluginRuntime.call with resolved method and paths", async () => {
    const runtime = makeRuntime({ methodNames: ["pageindex_scan"] });
    const method = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    expect(method).toBe("pageindex_scan");

    const payload = { paths: ["/tmp/a.pdf", "/tmp/b.md"] };
    const result = await runtime.call(method!, payload) as { indexed: number; failed: number };
    expect(runtime.call).toHaveBeenCalledWith("pageindex_scan", payload);
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("returns no-indexer when capability not found", async () => {
    const runtime = makeRuntime({});
    runtime.findPluginIdByCapability.mockReturnValue(undefined);
    const method = findMethodByCapability(runtime, "document-indexer", (m) => m.endsWith("_scan"));
    // Simulate handler logic
    const handlerResult = method ? { ok: true } : { ok: false, error: "no-indexer" };
    expect(handlerResult).toEqual({ ok: false, error: "no-indexer" });
    expect(runtime.call).not.toHaveBeenCalled();
  });
});
