/**
 * Returns the marketplace base URL from the persisted settings
 * (`settings.marketplace.realCloudBaseUrl`) together with an explicit
 * `loaded` flag.
 *
 * `loaded` is `false` until `getSettings()` resolves for the first time.
 * Once it resolves, `loaded` becomes `true` regardless of whether
 * `marketplaceUrl` is empty (an intentionally blank URL in settings is a
 * distinct state from "not yet fetched"). Callers that open an external link
 * MUST check `loaded && marketplaceUrl` to avoid both empty-URL shell calls
 * and premature navigation during the async init window.
 */
import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

export interface MarketplaceUrlState {
  marketplaceUrl: string;
  /** `false` until the first `getSettings()` response arrives. */
  loaded: boolean;
}

export function useMarketplaceUrl(api: LvisApi): MarketplaceUrlState {
  const [marketplaceUrl, setMarketplaceUrl] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setMarketplaceUrl((s.marketplace?.realCloudBaseUrl ?? "").trim());
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return { marketplaceUrl, loaded };
}
