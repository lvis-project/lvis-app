import { describe, expect, it, vi } from "vitest";

const file = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: file.open }));
vi.mock("../../shared/image-preparation-policy.js", async (original) => {
  const actual = await original<typeof import("../../shared/image-preparation-policy.js")>();
  return { ...actual, IMAGE_PREPARATION_POLICY: { ...actual.IMAGE_PREPARATION_POLICY, maxInputBytes: 64, readChunkBytes: 16 } };
});
import { readImageInput } from "../image-preparation-input.js";

describe("image source read bounds", () => {
  it("bounds actual reads when a file grows after the opened handle size check", async () => {
    const source = Buffer.alloc(100);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source);
    const close = vi.fn(async () => {});
    let highestRead = 0;
    file.open.mockResolvedValue({
      stat: async () => ({ size: 8, isFile: () => true }), close,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        highestRead = Math.max(highestRead, position + length);
        return { bytesRead: source.copy(buffer, offset, position, position + length) };
      },
    });
    await expect(readImageInput("growing.png", new AbortController().signal)).rejects.toThrow("Source grew");
    expect(highestRead).toBe(65);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the opened handle when cancelled during a read", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    file.open.mockResolvedValue({
      stat: async () => ({ size: 8, isFile: () => true }), close,
      read: async () => { controller.abort(new Error("read cancelled")); return { bytesRead: 0 }; },
    });
    await expect(readImageInput("cancelled.png", controller.signal)).rejects.toThrow("read cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses special files without reading their contents", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn();
    file.open.mockResolvedValue({ stat: async () => ({ isFile: () => false }), read, close });
    await expect(readImageInput("pipe", new AbortController().signal)).rejects.toThrow("regular file");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
