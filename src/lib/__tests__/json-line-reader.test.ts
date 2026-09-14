import { describe, expect, it, vi } from "vitest";
import { JsonLineReader } from "../json-line-reader.js";

function makeReader(maxLineBytes = 32) {
  const onMessage = vi.fn();
  const onError = vi.fn();
  return { reader: new JsonLineReader({ maxLineBytes, onMessage, onError }), onMessage, onError };
}

describe("JSON line framing", () => {
  it("accepts coalesced lines even when the chunk exceeds one line limit", () => {
    const { reader, onMessage, onError } = makeReader(7);
    reader.write('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(onMessage.mock.calls).toEqual([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains split UTF-8 and fragmented lines", () => {
    const { reader, onMessage, onError } = makeReader();
    const bytes = Buffer.from('{"text":"한글"}\n');
    for (const byte of bytes) reader.write(Buffer.from([byte]));
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ text: "한글" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("counts bytes across fragments and fails once without later delivery", () => {
    const { reader, onMessage, onError } = makeReader(5);
    reader.write('"한');
    reader.write('글"\n0\n');
    reader.write('1\n');
    expect(onError).toHaveBeenCalledExactlyOnceWith("frame-too-large");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("accepts an exact byte limit and skips empty lines", () => {
    const { reader, onMessage, onError } = makeReader(5);
    reader.write('\n \r\n"한"\n');
    expect(onMessage).toHaveBeenCalledExactlyOnceWith("한");
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops after malformed JSON", () => {
    const { reader, onMessage, onError } = makeReader();
    reader.write('bad\n{}\n');
    reader.write('{}\n');
    expect(onError).toHaveBeenCalledExactlyOnceWith("invalid-json");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("stops delivery when its owner closes during a callback", () => {
    const messages: unknown[] = [];
    const reader = new JsonLineReader({
      maxLineBytes: 5,
      onMessage: (message) => { messages.push(message); reader.close(); },
      onError: vi.fn(),
    });
    reader.write('1\n2\n');
    reader.write('3\n');
    expect(messages).toEqual([1]);
  });

  it("does not publish an unfinished frame", () => {
    const { reader, onMessage } = makeReader();
    reader.write('{"a":1}');
    reader.close();
    reader.write('\n');
    expect(onMessage).not.toHaveBeenCalled();
  });
});
