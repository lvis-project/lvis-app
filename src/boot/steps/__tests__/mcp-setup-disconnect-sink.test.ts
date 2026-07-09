/**
 * #885 b3 — the disconnect sink wired into McpManager at boot.
 *
 * Asserts the MAJOR-2 clearStorageData + the strict ordering broadcast → close →
 * clear (so no live detached webContents races a wiped jar), the isDestroyed()
 * guard, lazy null WindowManager tolerance, and the MINOR-A outer try/catch that
 * swallows a synchronous throw from over-length name derivation.
 */
import { describe, it, expect, vi } from "vitest";
import { createMcpServerDisconnectedSink } from "../mcp-setup.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { mcpAppPartitionName, MAX_SERVER_ID_LEN } from "../../../shared/mcp-app-partition.js";

function harness() {
  const order: string[] = [];
  const send = vi.fn(() => order.push("broadcast"));
  const destroyedSend = vi.fn();
  const closeDetachedMcpWindows = vi.fn(() => order.push("close"));
  const clearStorageData = vi.fn(() => {
    order.push("clear");
    return Promise.resolve();
  });
  const fromPartition = vi.fn((name: string) => {
    order.push(`from:${name}`);
    return { clearStorageData };
  });
  const sink = createMcpServerDisconnectedSink({
    getWindowManager: () => ({ closeDetachedMcpWindows }),
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    ],
    fromPartition,
  });
  return { order, send, destroyedSend, closeDetachedMcpWindows, clearStorageData, fromPartition, sink };
}

describe("createMcpServerDisconnectedSink", () => {
  it("broadcasts to non-destroyed windows only, then close, then clear (order)", () => {
    const h = harness();
    h.sink("github");

    expect(h.send).toHaveBeenCalledWith(CHANNELS.mcp.serverDisconnected, { serverId: "github" });
    expect(h.destroyedSend).not.toHaveBeenCalled(); // isDestroyed() guard (Q4 shutdown)
    expect(h.closeDetachedMcpWindows).toHaveBeenCalledWith("github");
    expect(h.clearStorageData).toHaveBeenCalledOnce();
    expect(h.fromPartition).toHaveBeenCalledWith(mcpAppPartitionName("github"));

    // Order: broadcast → close → clear.
    expect(h.order.indexOf("broadcast")).toBeLessThan(h.order.indexOf("close"));
    expect(h.order.indexOf("close")).toBeLessThan(h.order.indexOf("clear"));
  });

  it("tolerates a null WindowManager (lazy resolution before window creation)", () => {
    const clearStorageData = vi.fn(() => Promise.resolve());
    const send = vi.fn();
    const sink = createMcpServerDisconnectedSink({
      getWindowManager: () => null,
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
      fromPartition: () => ({ clearStorageData }),
    });
    expect(() => sink("github")).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
    expect(clearStorageData).toHaveBeenCalledOnce();
  });

  it("swallows a synchronous throw from an over-length id (MINOR-A) — broadcast still ran", () => {
    const send = vi.fn();
    const clearStorageData = vi.fn(() => Promise.resolve());
    // Real closeDetachedMcpWindows would derive mcpAppViewKeyPrefix(id) and throw;
    // even with a no-throw stub, mcpAppPartitionName(id) throws at the clear step.
    const sink = createMcpServerDisconnectedSink({
      getWindowManager: () => ({ closeDetachedMcpWindows: vi.fn() }),
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
      fromPartition: () => ({ clearStorageData }),
    });
    const tooLong = "a".repeat(MAX_SERVER_ID_LEN + 1);
    expect(() => sink(tooLong)).not.toThrow();
    expect(send).toHaveBeenCalledOnce(); // broadcast completed before the throw
    expect(clearStorageData).not.toHaveBeenCalled(); // name derivation threw first
  });
});
