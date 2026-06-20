import { describe, it, expect, vi } from "vitest";
import { createPluginNetworkFetch } from "../plugin-network-fetch.js";

function stubResponse(label: string): Response {
  return new Response(label, { status: 200 });
}

describe("createPluginNetworkFetch", () => {
  const PRIVATE = "aif-swc-axpg-hq-hckt19.openai.azure.com";
  const isPrivate = (url: URL) => url.hostname === PRIVATE;

  function harness() {
    const calls: Array<{ which: "default" | "private"; input: unknown }> = [];
    const defaultFetch = vi.fn(async (input: unknown) => {
      calls.push({ which: "default", input });
      return stubResponse("default");
    }) as unknown as typeof fetch;
    const privateFetch = vi.fn(async (input: unknown) => {
      calls.push({ which: "private", input });
      return stubResponse("private");
    }) as unknown as typeof fetch;
    const fetchImpl = createPluginNetworkFetch(defaultFetch, privateFetch, isPrivate);
    return { fetchImpl, calls };
  }

  it("routes a private-endpoint URL through the direct (proxy-bypassing) fetch", async () => {
    const { fetchImpl, calls } = harness();
    const res = await fetchImpl(
      `https://${PRIVATE}/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-01-01-preview`,
    );
    expect(await res.text()).toBe("private");
    expect(calls).toEqual([{ which: "private", input: expect.any(String) }]);
  });

  it("routes a non-mapped host through the default (proxied) fetch", async () => {
    const { fetchImpl, calls } = harness();
    const res = await fetchImpl("https://api.openai.com/v1/audio/transcriptions");
    expect(await res.text()).toBe("default");
    expect(calls[0].which).toBe("default");
  });

  it("accepts a URL instance and routes it correctly", async () => {
    const { fetchImpl, calls } = harness();
    await fetchImpl(new URL(`https://${PRIVATE}/x`));
    expect(calls[0].which).toBe("private");
  });

  it("accepts a Request instance and routes by its url", async () => {
    const { fetchImpl, calls } = harness();
    await fetchImpl(new Request(`https://${PRIVATE}/y`));
    expect(calls[0].which).toBe("private");
  });

  it("falls to the default fetch for an unparseable/relative input (no host to map)", async () => {
    const { fetchImpl, calls } = harness();
    await fetchImpl("/relative/path");
    expect(calls[0].which).toBe("default");
  });

  it("forwards the init argument unchanged", async () => {
    const defaultSpy = vi.fn(async () => stubResponse("d")) as unknown as typeof fetch;
    const fi = createPluginNetworkFetch(defaultSpy, defaultSpy, () => false);
    const init = { method: "POST", body: "audio-bytes" };
    await fi("https://example.com/u", init);
    expect(defaultSpy).toHaveBeenCalledWith("https://example.com/u", init);
  });
});
