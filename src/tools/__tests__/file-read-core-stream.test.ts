import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadStream, type ReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readTextFileWindow } from "../file-read-core.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  createReadStream: vi.fn(),
}));

afterEach(() => {
  vi.mocked(createReadStream).mockReset();
});

function sourceStream(chunks: string[]): Readable {
  const input = Readable.from(chunks, { encoding: "utf8", objectMode: false, highWaterMark: 1 });
  vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
  return input;
}

describe("exact text stream windows", () => {
  it("preserves mixed separators at every chunk split", async () => {
    const source = "before\r\nalpha\rbeta\ngamma\r\nafter";
    for (let split = 1; split < source.length; split += 1) {
      const input = sourceStream([source.slice(0, split), source.slice(split)]);
      expect(await readTextFileWindow("synthetic.txt", 1, 3)).toEqual({
        lines: ["alpha", "beta", "gamma"],
        content: "alpha\rbeta\ngamma",
        truncated: true,
      });
      expect(input.destroyed).toBe(true);
      expect(input.closed).toBe(true);
    }
  });

  it("distinguishes empty lines when every character arrives separately", async () => {
    const input = sourceStream([..."\r\n\r\nalpha\rbeta\n"]);
    expect(await readTextFileWindow("synthetic.txt", 0, 20)).toEqual({
      lines: ["", "", "alpha", "beta"],
      content: "\r\n\r\nalpha\rbeta",
      truncated: false,
    });
    expect(input.closed).toBe(true);
  });

  it("closes an unfinished stream after proving truncation", async () => {
    const input = new Readable({
      encoding: "utf8",
      read() { this.push("alpha\r\nbeta\r\n"); },
    });
    vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
    expect(await readTextFileWindow("synthetic.txt", 0, 1)).toEqual({
      lines: ["alpha"], content: "alpha", truncated: true,
    });
    expect(input.destroyed).toBe(true);
    expect(input.closed).toBe(true);
  });

  it("propagates read failures and closes the stream", async () => {
    const failure = new Error("synthetic read failure");
    const input = new Readable({ read() { this.destroy(failure); } });
    vi.mocked(createReadStream).mockReturnValueOnce(input as ReadStream);
    await expect(readTextFileWindow("synthetic.txt", 0, 2)).rejects.toBe(failure);
    expect(input.destroyed).toBe(true);
    expect(input.closed).toBe(true);
  });
});
