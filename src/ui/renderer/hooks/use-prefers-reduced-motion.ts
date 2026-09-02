/**
 * The one reading of `prefers-reduced-motion: reduce` for the renderer.
 *
 * Subscription, not a mount-time snapshot: the OS toggle can flip while a
 * surface is on screen, and a surface that read the preference once keeps
 * animating (or stays static) until it remounts. Two components used to carry
 * their own subscribing copies of this hook and three others read it once —
 * the same preference answered differently depending on which surface asked.
 *
 * Chromium's `MediaQueryList` is an `EventTarget`; there is no runtime here
 * without `addEventListener`, so no legacy `addListener` branch.
 */
import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/** Current preference; `false` where `matchMedia` is absent (non-DOM tests). */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const onChange = () => setReduce(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}
