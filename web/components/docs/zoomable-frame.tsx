"use client";
import * as React from "react";
import { Maximize2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";

interface Props {
  eyebrow: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}

export function ZoomableFrame({ eyebrow, title, caption, children }: Props) {
  return (
    <Dialog>
      <figure className="group my-8 overflow-hidden rounded-xl border border-border bg-white">
        <header className="flex items-center justify-between border-b border-border bg-secondary/40 px-5 py-3">
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-teal-dark">
              {eyebrow}
            </p>
            <h3 className="text-[15.5px] font-semibold text-ink">{title}</h3>
          </div>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft transition hover:border-teal/40 hover:text-teal"
              aria-label={`${title} 확대`}
            >
              <Maximize2 className="h-3 w-3" /> 확대
            </button>
          </DialogTrigger>
        </header>
        <DialogTrigger asChild>
          <button
            type="button"
            className="block w-full cursor-zoom-in bg-white px-3 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-teal"
            aria-label={`${title} 확대`}
          >
            {children}
          </button>
        </DialogTrigger>
        <figcaption className="border-t border-border bg-white px-5 py-2.5 text-[12.5px] text-muted-foreground">
          {caption}
        </figcaption>
      </figure>

      <DialogContent className="w-[min(98vw,1400px)] max-w-none">
        <DialogTitle className="text-[15px] font-semibold text-ink">{title}</DialogTitle>
        <DialogDescription className="sr-only">{caption}</DialogDescription>
        <div className="overflow-x-auto bg-white">{children}</div>
        <p className="text-[12.5px] text-muted-foreground">{caption}</p>
      </DialogContent>
    </Dialog>
  );
}
