// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createOnReadResource } from "../on-read-resource.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOnReadResource", () => {
  it("proxies resources/read to window.lvis.mcp.readUiResource and wraps the html as an mcp-app resource", async () => {
    const readUiResource = vi.fn(async () => ({ html: "<html><body>card</body></html>" }));
    vi.stubGlobal("lvis", { mcp: { readUiResource } });

    const handler = createOnReadResource({ serverId: "github" }) as (
      p: { uri: string },
    ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;

    const result = await handler({ uri: "ui://card/1" });

    // The serverId is bound at wire time; the app supplies only the uri.
    expect(readUiResource).toHaveBeenCalledWith("github", "ui://card/1");
    expect(result).toEqual({
      contents: [
        {
          uri: "ui://card/1",
          mimeType: "text/html;profile=mcp-app",
          text: "<html><body>card</body></html>",
        },
      ],
    });
  });

  it("REFUSES any non-ui:// uri before the IPC (fail closed)", async () => {
    const readUiResource = vi.fn(async () => ({ html: "" }));
    vi.stubGlobal("lvis", { mcp: { readUiResource } });

    const handler = createOnReadResource({ serverId: "github" }) as (
      p: { uri: unknown },
    ) => Promise<unknown>;

    // The uri is the ONE value the app supplies. Anything outside the card surface —
    // another resource family on the same server, a file, an http(s) URL — is refused, and
    // never reaches the read chokepoint (whose every call also mints a proxy-session token
    // from a bounded LRU, so a read loop would evict other live cards' tokens).
    for (const uri of [
      "file:///etc/passwd",
      "https://evil.example/x",
      "resource://secret/1",
      "UI://card/1",
      "",
      undefined,
      42,
    ]) {
      await expect(handler({ uri }), `uri=${String(uri)}`).rejects.toThrow(/ui:\/\//);
    }
    expect(readUiResource).not.toHaveBeenCalled();
  });
});
