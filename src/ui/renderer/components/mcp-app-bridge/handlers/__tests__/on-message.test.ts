// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createOnMessage } from "../on-message.js";
import type { McpUiMessageOutcome } from "../../../../../../mcp/mcp-ui-message.js";

type MessageParams = { role: "user"; content: Array<{ type: string; text?: string }> };
type Handler = (p: MessageParams) => Promise<{ isError?: boolean }>;

function build(outcome: McpUiMessageOutcome | Error) {
  const postMessage = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { postMessage, handler: createOnMessage({ postMessage }) as unknown as Handler };
}

const params: MessageParams = { role: "user", content: [{ type: "text", text: "hello host" }] };

describe("createOnMessage — the app names neither a server nor a session", () => {
  it("forwards ONLY the spec params to the bound poster", async () => {
    const { postMessage, handler } = build({ ok: true, disposition: "queued" });

    await handler(params);

    // serverId + sessionId are absent here: McpAppView bound both from the card.
    expect(postMessage).toHaveBeenCalledWith(params);
  });
});

describe("createOnMessage — the result never carries conversation content", () => {
  it("accepts with an EMPTY result, whatever the host did with the message", async () => {
    for (const disposition of ["queued", "staged", "notified"] as const) {
      const { handler } = build({ ok: true, disposition });
      await expect(handler(params)).resolves.toEqual({});
    }
  });

  it("rejects with `{ isError: true }` and nothing else", async () => {
    const { handler } = build({ ok: false, error: "rate-limited", message: "too many messages" });

    const result = await handler(params);

    expect(result).toEqual({ isError: true });
    // Not even the host's own reason leaks back into the app frame.
    expect(JSON.stringify(result)).not.toContain("rate-limited");
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an error RESULT, not a throw", async () => {
    const { handler } = build(new Error("unauthorized-frame"));

    await expect(handler(params)).resolves.toEqual({ isError: true });
  });
});
