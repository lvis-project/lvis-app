/**
 * Returns the marketplace base URL from the persisted settings
 * (`settings.marketplace.realCloudBaseUrl`).
 *
 * The default value in settings-store.ts guarantees the field is always
 * populated — no runtime fallback logic needed here.
 */
import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

export function useMarketplaceUrl(api: LvisApi): string {
  const [url, setUrl] = useState<string>("");

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const configured = s.marketplace?.realCloudBaseUrl;
        if (configured) setUrl(configured);
      })
      .catch(() => {});
  }, [api]);

  return url;
}
