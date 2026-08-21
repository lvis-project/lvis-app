import { describe, expect, it, vi } from "vitest";
import {
  configuredModelProviderLoopbackAccess,
  configuredModelProviderNetworkAccess,
  createGuardedMarketplaceProviderFetch,
  createGuardedModelProviderFetch,
  isGuardedInsecureCredentialedModelProviderFetch,
} from "../marketplace-provider-fetch.js";

describe("guarded model-provider fetch", () => {
  it("rejects a public cross-origin request before it can forward credentials", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const providerFetch = createGuardedModelProviderFetch(
      "http://10.232.178.100:30000/v1",
      fetchImpl,
    );

    await expect(
      providerFetch("https://example.com/exfiltrate", {
        headers: { Authorization: "Bearer internal-key" },
      }),
    ).rejects.toThrow("configured origin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("permits credentialed HTTP only for the self-hosted guarded fetch", () => {
    const baseUrl = "http://10.232.178.100:30000/v1";
    const selfHostedFetch = createGuardedModelProviderFetch(baseUrl);
    const marketplaceFetch = createGuardedMarketplaceProviderFetch(baseUrl, {
      providerId: "private-marketplace",
      label: "Private marketplace provider",
      baseUrl,
      defaultModel: "private/model",
      modelOptions: ["private/model"],
      requiresApiKey: true,
    });

    expect(isGuardedInsecureCredentialedModelProviderFetch(baseUrl, selfHostedFetch)).toBe(true);
    expect(isGuardedInsecureCredentialedModelProviderFetch(baseUrl, marketplaceFetch)).toBe(false);
  });

  it("rejects every request and registers no trust policy when the baseUrl is unparseable", async () => {
    // `originFor("not a url")` hits the URL-constructor catch and returns null,
    // so `configuredOrigin` is null: no request can equal an absent origin, and
    // the `if (configuredOrigin)` policy-registration guard is skipped.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const providerFetch = createGuardedModelProviderFetch("not a url", fetchImpl);

    await expect(
      providerFetch("http://10.0.0.5:8000/v1/models", {
        headers: { Authorization: "Bearer internal-key" },
      }),
    ).rejects.toThrow("configured origin");
    expect(fetchImpl).not.toHaveBeenCalled();

    // No policy was recorded for the unparseable baseUrl, so credentialed-HTTP
    // trust cannot be claimed for it.
    expect(
      isGuardedInsecureCredentialedModelProviderFetch("not a url", providerFetch),
    ).toBe(false);
  });
});

describe("tailnet reach for a saved self-hosted endpoint", () => {
  const tailnetBase = "http://100.75.34.2:30000/v1";

  it("opens the CGNAT axis for the configured origin only", () => {
    const access = configuredModelProviderNetworkAccess(tailnetBase);
    const scope = access.allowCarrierGradeNat;
    expect(typeof scope).toBe("function");
    if (typeof scope !== "function") return;
    expect(scope(new URL(tailnetBase))).toBe(true);
    // A redirect or SDK pivot to any other tailnet peer stays closed.
    expect(scope(new URL("http://100.83.225.18:30000/v1"))).toBe(false);
    expect(scope(new URL("http://100.75.34.2:8080/v1"))).toBe(false);
  });

  it("keeps the CGNAT axis closed for a keyless marketplace preset", () => {
    expect(configuredModelProviderLoopbackAccess(tailnetBase).allowCarrierGradeNat).toBe(false);
  });

  it("keeps the CGNAT axis closed for a key-bearing marketplace preset fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const presetFetch = createGuardedMarketplaceProviderFetch(
      tailnetBase,
      {
        providerId: "private-marketplace",
        label: "Private marketplace provider",
        baseUrl: tailnetBase,
        defaultModel: "private/model",
        modelOptions: ["private/model"],
        requiresApiKey: true,
      },
      fetchImpl,
    );

    await expect(presetFetch(`${tailnetBase}/models`)).rejects.toThrow(/non-public/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets the saved self-hosted fetch reach its tailnet origin", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const providerFetch = createGuardedModelProviderFetch(tailnetBase, fetchImpl);

    const response = await providerFetch(`${tailnetBase}/models`);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
