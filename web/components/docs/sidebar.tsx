"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getNavigation } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { localeFromPathname } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

/** usePathname() drops the trailing slash; nav hrefs may carry one. */
const norm = (s: string) => s.replace(/\/$/, "") || "/";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const navigation = getNavigation(locale);
  return (
    <nav aria-label={uiStrings(locale).sidebarLabel} className="flex h-full flex-col gap-7 pr-3">
      {navigation.map((group) => (
        <div key={group.title}>
          {group.eyebrow ? (
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">
              {group.eyebrow}
            </p>
          ) : null}
          <p className="mb-2 text-[13px] font-semibold text-ink">{group.title}</p>
          <ul className="grid gap-0.5">
            {group.items.map((item) => {
              const active = norm(pathname) === norm(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center justify-between gap-2 rounded-lg py-1.5 pl-3 pr-2 text-[13.5px] leading-snug transition-colors",
                      active
                        ? "bg-secondary font-semibold text-ink"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-ink"
                    )}
                  >
                    {/* sliding active indicator */}
                    <span
                      className={cn(
                        "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-ink transition-all duration-200",
                        active ? "opacity-100" : "opacity-0 group-hover:opacity-40"
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{item.title}</span>
                    {item.badge ? (
                      <span className="shrink-0 rounded-full bg-accent px-1.5 py-0 text-[9.5px] font-bold uppercase tracking-wide text-ink-soft">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
