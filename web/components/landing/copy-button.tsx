"use client";
import * as React from "react";
import { Check, Copy } from "lucide-react";
import type { Locale } from "@/lib/i18n";

const copy = {
  ko: { aria: "명령 복사", copied: "복사됨", copy: "복사" },
  en: { aria: "Copy command", copied: "Copied", copy: "Copy" },
} as const;

/** Small clipboard button for shell commands. */
export function CopyButton({ text, locale = "ko" }: { text: string; locale?: Locale }) {
  const t = copy[locale];
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={t.aria}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t.copied : t.copy}
    </button>
  );
}
