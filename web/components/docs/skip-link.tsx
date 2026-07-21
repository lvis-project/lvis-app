"use client";
import { usePathname } from "next/navigation";
import { localeFromPathname } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

export function SkipLink() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  return (
    <a
      href="#docs-main"
      className="fixed left-3 top-3 z-[60] -translate-y-20 rounded-full bg-ink px-3 py-2 text-sm font-semibold text-white transition-transform focus:translate-y-0"
    >
      {uiStrings(locale).skipToContent}
    </a>
  );
}
