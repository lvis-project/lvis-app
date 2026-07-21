"use client";
import { usePathname } from "next/navigation";
import { localeFromPathname, href } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

export function SiteFooter() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);

  const footerLinks = [
    {
      title: strings.footerProduct,
      links: [
        { label: strings.footerHome, href: href(locale, "/") },
        { label: "Marketplace", href: "https://marketplace.lvisai.xyz" },
        { label: "Agent Hub", href: "https://agent-hub.lvisai.xyz" },
      ],
    },
    {
      title: strings.footerDocs,
      links: [
        { label: strings.footerLinks.start, href: href(locale, "/docs/getting-started/install") },
        { label: strings.footerLinks.plugins, href: href(locale, "/docs/plugins") },
        { label: strings.footerLinks.architecture, href: href(locale, "/docs/architecture/overview") },
        { label: strings.footerLinks.roadmap, href: href(locale, "/docs/roadmap") },
      ],
    },
  ];

  return (
    <footer className="mt-24 border-t border-border/70">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-14 sm:grid-cols-[1.4fr_1fr_1fr] sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/lvis-mark.svg" alt="" className="h-5 w-5" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-ink">LVIS AI</span>
          </div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
            {strings.footerTagline}
          </p>
        </div>
        {footerLinks.map((col) => (
          <div key={col.title}>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              {col.title}
            </p>
            <ul className="mt-3 grid gap-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    className="text-[13.5px] text-ink-soft transition-colors hover:text-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/70">
        <div className="mx-auto max-w-[1440px] px-4 py-5 text-[12.5px] text-muted-foreground sm:px-6">
          © LVIS AI · lvisai.xyz
        </div>
      </div>
    </footer>
  );
}
