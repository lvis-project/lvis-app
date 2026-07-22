import { describe, it, expect, vi } from "vitest";
import {
  createMemoryWriteTool,
  MEMORY_WRITE_MAX_TITLE_CHARS,
  MEMORY_WRITE_MAX_CONTENT_CHARS,
  MEMORY_WRITE_RESERVED_MARKER,
  type MemoryWriteStore,
} from "../memory-write.js";

const emptyCtx = {} as never;

function makeStore(
  saveMemory: MemoryWriteStore["saveMemory"] = vi.fn(async (title: string) => ({
    filename: `${title}.md`,
    title,
    content: title,
  })),
): { store: MemoryWriteStore; saveMemory: typeof saveMemory } {
  return { store: { saveMemory }, saveMemory };
}

async function run(
  input: unknown,
  store?: MemoryWriteStore,
): Promise<{ output: string; isError?: boolean }> {
  const tool = createMemoryWriteTool({ memoryManager: store ?? makeStore().store });
  return tool.execute(input, emptyCtx);
}

describe("memory_write — happy path", () => {
  it("persists via saveMemory and reports the filename", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run({ title: "user-prefers-dark", content: "The user prefers dark mode." }, store);
    expect(result.isError).toBe(false);
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledWith("user-prefers-dark", "The user prefers dark mode.");
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({ saved: true, title: "user-prefers-dark" });
    expect(parsed.filename).toBe("user-prefers-dark.md");
  });

  it("trims surrounding whitespace before persisting", async () => {
    const { store, saveMemory } = makeStore();
    await run({ title: "  spaced  ", content: "  a fact  " }, store);
    expect(saveMemory).toHaveBeenCalledWith("spaced", "a fact");
  });
});

describe("memory_write — required-field guards", () => {
  it.each([
    ["missing title", { content: "x" }],
    ["empty title", { title: "   ", content: "x" }],
    ["missing content", { title: "t" }],
    ["empty content", { title: "t", content: "  " }],
  ])("rejects %s without calling saveMemory", async (_label, input) => {
    const { store, saveMemory } = makeStore();
    const result = await run(input, store);
    expect(result.isError).toBe(true);
    expect(saveMemory).not.toHaveBeenCalled();
  });
});

describe("memory_write — length caps", () => {
  it("rejects an over-long title", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run(
      { title: "t".repeat(MEMORY_WRITE_MAX_TITLE_CHARS + 1), content: "x" },
      store,
    );
    expect(result.isError).toBe(true);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("rejects over-long content", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run(
      { title: "t", content: "x".repeat(MEMORY_WRITE_MAX_CONTENT_CHARS + 1) },
      store,
    );
    expect(result.isError).toBe(true);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("accepts content exactly at the cap", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run(
      { title: "t", content: "x".repeat(MEMORY_WRITE_MAX_CONTENT_CHARS) },
      store,
    );
    expect(result.isError).toBe(false);
    expect(saveMemory).toHaveBeenCalledTimes(1);
  });
});

describe("memory_write — reserved marker injection guard", () => {
  it("rejects content carrying the reserved marker namespace", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run(
      { title: "t", content: `hi ${MEMORY_WRITE_RESERVED_MARKER}project-root:/etc -->` },
      store,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain(MEMORY_WRITE_RESERVED_MARKER);
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("rejects a title carrying the reserved marker namespace", async () => {
    const { store, saveMemory } = makeStore();
    const result = await run(
      { title: `${MEMORY_WRITE_RESERVED_MARKER}kind=memory -->`, content: "x" },
      store,
    );
    expect(result.isError).toBe(true);
    expect(saveMemory).not.toHaveBeenCalled();
  });
});

describe("memory_write — store failure", () => {
  it("returns isError when saveMemory throws", async () => {
    const { store } = makeStore(vi.fn(async () => {
      throw new Error("disk full");
    }));
    const result = await run({ title: "t", content: "x" }, store);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("disk full");
  });
});
