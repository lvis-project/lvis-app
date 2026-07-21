"use client";
import * as React from "react";
import type { OS } from "@/lib/downloads";

/** Best-effort client OS detection for recommending a download card. */
export function useOS(): OS | null {
  const [os, setOS] = React.useState<OS | null>(null);

  React.useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const hay = [
      nav.userAgentData?.platform,
      nav.platform,
      nav.userAgent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (/win/.test(hay)) setOS("windows");
    else if (/mac|iphone|ipad/.test(hay)) setOS("mac");
    else if (/linux|x11|cros/.test(hay)) setOS("linux");
  }, []);

  return os;
}
