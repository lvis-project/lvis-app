"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { localeFromPathname } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

export function Toc() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  const [headings, setHeadings] = React.useState<Heading[]>([]);
  const [active, setActive] = React.useState<string | null>(null);

  React.useEffect(() => {
    const main = document.querySelector("main#docs-main");
    if (!main) return;
    const nodes = Array.from(main.querySelectorAll("h2[id], h3[id]")) as HTMLElement[];
    const items: Heading[] = nodes.map((n) => ({
      id: n.id,
      text: n.textContent ?? "",
      level: n.tagName.toLowerCase() === "h2" ? 2 : 3,
    }));
    setHeadings(items);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-88px 0px -62% 0px", threshold: [0, 1] }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  if (headings.length < 2) return null;

  return (
    <nav
      aria-label={strings.tocLabel}
      className="sticky top-[4.5rem] hidden h-[calc(100dvh-6rem)] w-56 shrink-0 overflow-y-auto py-2 xl:block"
    >
      <p className="mb-3 pl-4 text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {strings.onThisPage}
      </p>
      <ul className="grid">
        {headings.map((h) => {
          const on = active === h.id;
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                className={cn(
                  "block border-l-2 py-1 text-[12.5px] leading-snug transition-colors",
                  h.level === 3 ? "pl-7" : "pl-4",
                  on
                    ? "border-ink font-medium text-ink"
                    : "border-border text-muted-foreground hover:border-ink/40 hover:text-ink"
                )}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
