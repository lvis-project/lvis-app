import { describe, it, expect, vi } from "vitest";
import { createOnSandboxReady } from "../on-sandbox-ready.js";

describe("createOnSandboxReady", () => {
  it("answers the ready notification with the app document — html only, no sandbox field", () => {
    const sendSandboxResourceReady = vi.fn();
    const handler = createOnSandboxReady({
      bridge: { sendSandboxResourceReady },
      html: "<html><body>card</body></html>",
    });

    (handler as () => void)();

    expect(sendSandboxResourceReady).toHaveBeenCalledTimes(1);
    // The relay preload owns the inner iframe's sandbox attribute; sending a wire
    // `sandbox` value would be dead data, so the payload is html-only.
    expect(sendSandboxResourceReady.mock.calls[0]![0]).toEqual({
      html: "<html><body>card</body></html>",
    });
  });
});
