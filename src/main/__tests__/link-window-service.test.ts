import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  session: {
    fromPartition: vi.fn(() => ({
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      cookies: { flushStore: vi.fn() },
    })),
  },
}));

const { attachLinkNavigationGuards } = await import("../link-window-service.js");

function makeContents() {
  const handlers = new Map<string, (event: { url: string; preventDefault: () => void }) => void>();
  const contents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((eventName: string, handler: (event: { url: string; preventDefault: () => void }) => void) => {
      handlers.set(eventName, handler);
      return contents;
    }),
  } as unknown as WebContents & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
  return { contents, handlers };
}

function navEvent(url: string) {
  return { url, preventDefault: vi.fn() };
}

describe("attachLinkNavigationGuards", () => {
  it("denies popups and permits only http(s) top-level navigation", () => {
    const { contents, handlers } = makeContents();
    attachLinkNavigationGuards(contents);

    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });

    const httpsEvent = navEvent("https://example.com/path");
    handlers.get("will-navigate")!(httpsEvent);
    expect(httpsEvent.preventDefault).not.toHaveBeenCalled();

    const fileEvent = navEvent("file:///etc/passwd");
    handlers.get("will-navigate")!(fileEvent);
    expect(fileEvent.preventDefault).toHaveBeenCalledOnce();

    const redirectEvent = navEvent("lvis://plugin-auth/callback");
    handlers.get("will-redirect")!(redirectEvent);
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("jsonForScriptBlock — script-block injection safety", () => {
  it("neutralizes a </script> sequence so the value cannot break out", async () => {
    const { jsonForScriptBlock } = await import("../link-window-service.js");
    const malicious = "https://ok.example/</script><script>alert(1)</script>";
    const out = jsonForScriptBlock(malicious);
    // No raw angle bracket survives — a parser can never see a closing tag.
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c");
    // Still a valid JS string literal that round-trips to the original.
    // eslint-disable-next-line no-eval
    expect(JSON.parse(out.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"))).toBe(malicious);
  });

  it("leaves an ordinary URL intact as a parseable literal", async () => {
    const { jsonForScriptBlock } = await import("../link-window-service.js");
    const url = "https://example.com/path?a=1&b=2";
    expect(JSON.parse(jsonForScriptBlock(url))).toBe(url);
  });
});
