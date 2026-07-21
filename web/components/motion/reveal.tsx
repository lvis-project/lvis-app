"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  /** Stagger start, in ms. */
  delay?: number;
  /** Rootmargin trigger tweak. */
  once?: boolean;
  as?: "div" | "section" | "article" | "li" | "span" | "header" | "ol" | "ul";
};

/**
 * Fade + rise as the element scrolls into view. Progressive-enhancement safe:
 * server renders the hidden state, JS reveals on intersection. Falls back to
 * immediately-visible when IntersectionObserver is unavailable or the user
 * prefers reduced motion (also enforced in CSS).
 */
export function Reveal({ children, className, delay = 0, once = true, as = "div" }: RevealProps) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            if (once) io.unobserve(e.target);
          } else if (!once) {
            setShown(false);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref as React.Ref<HTMLElement>}
      className={cn("reveal", shown && "reveal-in", className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
