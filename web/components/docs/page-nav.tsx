"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { flattenNavFor } from "@/lib/navigation";
import { localeFromPathname } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

/** usePathname() drops the trailing slash; nav hrefs may carry one. */
const norm = (s: string) => s.replace(/\/$/, "") || "/";

export function PageNav() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  const items = flattenNavFor(locale);
  const idx = items.findIndex((i) => norm(i.href) === norm(pathname));
  if (idx < 0) return null;
  const prev = items[idx - 1];
  const next = items[idx + 1];
  return (
    <div className="mt-20 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          href={prev.href}
          className="group rounded-2xl border border-border bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" /> {strings.prev}
          </span>
          <p className="mt-1.5 text-[15px] font-semibold text-ink">{prev.title}</p>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group rounded-2xl border border-border bg-white p-5 text-right transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
        >
          <span className="flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {strings.next} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
          <p className="mt-1.5 text-[15px] font-semibold text-ink">{next.title}</p>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
