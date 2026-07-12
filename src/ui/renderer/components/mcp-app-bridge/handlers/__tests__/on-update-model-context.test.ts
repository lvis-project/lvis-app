// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createOnUpdateModelContext } from "../on-update-model-context.js";
import type { McpUiModelContextOutcome } from "../../../../../../mcp/mcp-app-model-context.js";

type ContextParams = { content?: unknown; structuredContent?: unknown };
type Handler = (p: ContextParams) => Promise<Record<string, unknown>>;

function build(outcome: McpUiModelContextOutcome | Error) {
  const updateModelContext = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return {
    updateModelContext,
    handler: createOnUpdateModelContext({ updateModelContext }) as unknown as Handler,
  };
}

const params: ContextParams = {
  content: [{ type: "text", text: "cart: 3 items" }],
  structuredContent: { items: 3 },
};

describe("createOnUpdateModelContext — the app names no server, session, or card", () => {
  it("forwards ONLY the spec params to the bound sink", async () => {
    const { updateModelContext, handler } = build({ ok: true, disposition: "stored" });

    await handler(params);

    // serverId + sessionId + cardId are absent: McpAppView bound all three.
    expect(updateModelContext).toHaveBeenCalledWith(params);
  });
});

describe("createOnUpdateModelContext — the result is an EmptyResult, always", () => {
  it("stored → `{}`", async () => {
    const { handler } = build({ ok: true, disposition: "stored" });

    await expect(handler(params)).resolves.toEqual({});
  });

  it("a host REFUSAL is still `{}` — the spec gives this request no error channel", async () => {
    // An over-cap body is an audit fact, not a protocol one. We neither invent an
    // `isError` the spec does not define nor reject the bridge request.
    const { handler } = build({ ok: false, error: "too-large", message: "context exceeds cap" });

    const result = await handler(params);

    expect(result).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  it("a stale-session drop is `{}` too", async () => {
    const { handler } = build({ ok: false, error: "session-mismatch", message: "not the active conversation" });

    await expect(handler(params)).resolves.toEqual({});
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an EmptyResult, not a throw", async () => {
    const { handler } = build(new Error("unauthorized-frame"));

    await expect(handler(params)).resolves.toEqual({});
  });
});
