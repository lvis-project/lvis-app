/**
 * Returns the marketplace base URL from the persisted settings
 * (`settings.marketplace.realCloudBaseUrl`).
 *
 * The settings store populates a default value, but the async `getSettings()`
 * call completes after the first render — callers must treat an empty string
 * as "not yet loaded" and guard against it (e.g. noop or disable the action).
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
