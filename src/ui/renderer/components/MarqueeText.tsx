// Horizontal auto-scroll for text that would otherwise be truncated.

import { useEffect, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Renders `text` on a single line. When the text fits its container it is shown
 * statically. When it overflows — and the user has not requested reduced motion
 * — the text scrolls horizontally in a seamless loop (the track is duplicated
 * and translated by -50%), pausing on hover or keyboard focus via CSS. Under
 * reduced motion (or before measurement) it falls back to a truncated label
 * with a `title` so the full text is still reachable on hover.
 *
 * Speed is proportional to the overflow distance (a fixed px/sec rate) so a
 * very long string does not whip past faster than a slightly-too-long one.
 * Measurement re-runs on container/content resize via ResizeObserver.
 */
export function MarqueeText({
  text,
  className,
  "data-testid": testId,
}: {
  text: string;
  className?: string;
  "data-testid"?: string;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    updatePreference();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updatePreference);
      return () => mediaQuery.removeEventListener("change", updatePreference);
    }
    mediaQuery.addListener?.(updatePreference);
    return () => mediaQuery.removeListener?.(updatePreference);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setOverflowing(false);
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const contentWidth = content.scrollWidth;
      const viewportWidth = viewport.clientWidth;
      const overflow = contentWidth - viewportWidth;
      if (overflow > 1) {
        setOverflowing(true);
        // ~40px/sec scroll, plus the baked-in end pauses (16% of the keyframe).
        const PX_PER_SEC = 40;
        const travel = contentWidth + 24; // content + gap between the two copies
        setDurationSec(Math.max(6, travel / PX_PER_SEC));
      } else {
        setOverflowing(false);
      }
    };

    measure();
    const ResizeObserverCtor = window.ResizeObserver;
    if (typeof ResizeObserverCtor !== "function") return;
    const observer = new ResizeObserverCtor(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text, reducedMotion]);

  const measurer = (
    <span ref={contentRef} className="invisible absolute whitespace-nowrap" aria-hidden>
      {text}
    </span>
  );

  const rootClassName = overflowing
    ? `relative lvis-marquee-viewport block min-w-0 ${className ?? ""}`
    : `relative block min-w-0 truncate ${className ?? ""}`;

  return (
    <span
      ref={viewportRef}
      className={rootClassName}
      title={text}
      data-testid={testId}
      data-marquee={overflowing ? "animate" : "static"}
      tabIndex={overflowing ? 0 : undefined}
    >
      {measurer}
      {overflowing ? (
        // Overflowing — scroll a duplicated track. aria-hidden on the second
        // copy so screen readers announce the text once.
        <span
          className="lvis-marquee-track"
          style={{ ["--lvis-marquee-duration" as string]: `${durationSec}s` }}
        >
          <span className="pr-6">
            {text}
          </span>
          <span className="pr-6" aria-hidden>
            {text}
          </span>
        </span>
      ) : (
        text
      )}
    </span>
  );
}
