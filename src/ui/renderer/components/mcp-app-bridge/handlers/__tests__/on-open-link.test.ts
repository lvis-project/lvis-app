import { describe, it, expect, vi } from "vitest";
import { createOnOpenLink } from "../on-open-link.js";

/** Invoke the handler ignoring the unused `RequestHandlerExtra` second arg. */
function invoke(handler: ReturnType<typeof createOnOpenLink>, url: string) {
  return (handler as (p: { url: string }) => Promise<{ isError?: boolean }>)({ url });
}

describe("createOnOpenLink", () => {
  it("returns {} (opened) when the gated opener accepted the URL", async () => {
    const openLink = vi.fn(async () => ({ ok: true }));
    const handler = createOnOpenLink({ openLink });

    const result = await invoke(handler, "https://example.com");

    expect(openLink).toHaveBeenCalledWith("https://example.com");
    expect(result).toEqual({});
  });

  it("returns { isError: true } when the host declined the URL", async () => {
    const openLink = vi.fn(async () => ({ ok: false }));
    const handler = createOnOpenLink({ openLink });

    const result = await invoke(handler, "file:///etc/passwd");

    expect(openLink).toHaveBeenCalledWith("file:///etc/passwd");
    expect(result).toEqual({ isError: true });
  });
});
