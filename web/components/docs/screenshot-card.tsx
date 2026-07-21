"use client";
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";

interface ScreenshotCardProps {
  src: string;
  caption: string;
  alt?: string;
  /** "wide" makes the card stretch to fill, "tall" preserves portrait crops */
  aspect?: "wide" | "tall" | "free";
  className?: string;
}

export function ScreenshotCard({
  src,
  caption,
  alt,
  aspect = "free",
  className,
}: ScreenshotCardProps) {
  return (
    <Dialog>
      <figure
        className={cn(
          "group relative overflow-hidden rounded-xl border border-border bg-white shadow-sm transition hover:shadow-md",
          className
        )}
      >
        <DialogTrigger asChild>
          <button
            type="button"
            className="block w-full bg-secondary/40 outline-none focus-visible:ring-2 focus-visible:ring-ink"
            aria-label={`확대 보기: ${caption}`}
          >
            <div
              className={cn(
                "relative w-full",
                aspect === "wide" && "aspect-[16/9]",
                aspect === "tall" && "aspect-[3/4]"
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt ?? caption}
                loading="lazy"
                className={cn(
                  "h-full w-full bg-white object-contain object-top",
                  aspect === "free" && "h-auto"
                )}
              />
            </div>
            <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-ink/75 px-2 py-1 text-[10.5px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
              <Maximize2 className="h-3 w-3" /> 확대
            </span>
          </button>
        </DialogTrigger>
        <figcaption className="border-t border-border bg-white/95 px-4 py-2.5 text-[12.5px] font-medium leading-snug text-muted-foreground">
          {caption}
        </figcaption>
      </figure>

      <DialogContent>
        <DialogTitle className="sr-only">{caption}</DialogTitle>
        <DialogDescription className="sr-only">{alt ?? caption}</DialogDescription>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? caption}
          className="mx-auto max-h-[82vh] w-auto rounded-md bg-white object-contain"
        />
        <p className="mt-1 text-center text-[13px] text-muted-foreground">{caption}</p>
      </DialogContent>
    </Dialog>
  );
}

export function ScreenshotGallery({
  children,
  columns = 2,
  className,
}: {
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <Reveal
      className={cn(
        "my-7 grid gap-4",
        columns === 1 && "grid-cols-1",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        className
      )}
    >
      {children}
    </Reveal>
  );
}
