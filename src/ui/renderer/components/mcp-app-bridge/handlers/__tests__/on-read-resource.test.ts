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
});
