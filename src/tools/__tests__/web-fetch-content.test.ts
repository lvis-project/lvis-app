import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../web-fetch.js";
import type { ToolExecutionContext } from "../types.js";

const url = "https://93.184.216.34/document";
const context: ToolExecutionContext = { cwd: "/", extraAllowedDirectories: [], metadata: {} };

function fetchTool(response: Response) {
  return createWebFetchTool(vi.fn(async () => response) as unknown as typeof fetch);
}

describe("web response content", () => {
  it.each([
    ["application/json", '{\n  "label": "a  <marker> b &lt; c"\n}\n'],
    ["text/plain", ">first\r\nAC GT\r\n>second\r\nTG CA\r\n"],
    ["application/xml", '<record label="two  spaces">value</record>\n'],
  ])("preserves %s response text", async (contentType, content) => {
    const result = await fetchTool(new Response(content, { headers: { "content-type": contentType } }))
      .execute({ url }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).content).toBe(content);
  });

  it("extracts readable text only for an HTML document", async () => {
    const result = await fetchTool(new Response("<style>hidden</style><p>Hello &lt;world&gt;</p><script>hidden</script>", {
      headers: { "content-type": "Text/HTML; charset=utf-8" },
    })).execute({ url }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).content).toBe("Hello <world>");
  });

  it("retains a long response tail for the shared result reader", async () => {
    const content = "start\n" + "line\n".repeat(2_000) + "TAIL-RECORD\n";
    const result = await fetchTool(new Response(content)).execute({ url }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ content, truncated: false });
  });

  it("preserves a multibyte character split across transport chunks", async () => {
    const bytes = new TextEncoder().encode("first\n가😀\nlast");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const result = await fetchTool(new Response(body)).execute({ url }, context);
    expect(JSON.parse(result.output).content).toBe("first\n가😀\nlast");
  });

  it("accepts empty chunks without treating them as the end of the response", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 1_000; i++) controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode("complete"));
        controller.close();
      },
    });
    const result = await fetchTool(new Response(body)).execute({ url }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).content).toBe("complete");
  });

  it.each([undefined, "1"])("cancels an oversized body even with content-length %s", async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel,
    });
    const result = await fetchTool(new Response(body, {
      headers: length ? { "content-length": length } : {},
    })).execute({ url }, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).details).toContain("body limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects an excessive declared length before reading the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const result = await fetchTool(new Response(body, {
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    })).execute({ url }, context);
    expect(result.isError).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects JSON escape expansion beyond the shared artifact limit", async () => {
    const result = await fetchTool(new Response("\u0000".repeat(1_000_000))).execute({ url }, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).details).toContain("tool result limit");
  });

  it("accepts the body boundary when its complete result remains recoverable", async () => {
    const content = "a".repeat(2 * 1024 * 1024);
    const result = await fetchTool(new Response(content)).execute({ url }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).content).toBe(content);
  });

  it("cancels a stalled body when the caller aborts after headers", async () => {
    const controller = new AbortController();
    let notifyRead!: () => void;
    const reading = new Promise<void>((resolve) => { notifyRead = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { notifyRead(); }, cancel }, { highWaterMark: 0 });
    const execution = fetchTool(new Response(body)).execute({ url }, { ...context, abortSignal: controller.signal });
    await reading;
    controller.abort(new Error("Caller stopped the request"));
    const result = await execution;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).details).toContain("Caller stopped");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not request a response after caller cancellation", async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await createWebFetchTool(fetch).execute({ url }, { ...context, abortSignal: controller.signal });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
