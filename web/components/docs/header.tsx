"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";
import { Button } from "@/components/ui/button";
import { CommandPaletteTrigger } from "./command-palette";
import { cn } from "@/lib/utils";
import { localeFromPathname, localePath, href as localeHref } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

/**
 * One nav, everywhere. Landing sections use absolute /# anchors (work from any
 * route); 문서 is a normal route and gets an active state under /docs/*.
 * Docs-internal navigation lives in the sidebar + ⌘K, not up here — so the
 * header never "switches personality" between landing and docs.
 */

export function Header() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  const inDocs = pathname.startsWith("/docs") || pathname.startsWith("/en/docs");
  const landingBase = localePath("/", locale);
  const otherLocale = locale === "en" ? "ko" : "en";

  const nav = [
    { label: strings.nav.workday, href: `${landingBase}#workday` },
    { label: strings.nav.download, href: `${landingBase}#download` },
    { label: strings.nav.architecture, href: `${landingBase}#architecture` },
    { label: strings.nav.roadmap, href: `${landingBase}#roadmap` },
    { label: strings.nav.docs, href: localeHref(locale, "/docs/"), isDocs: true },
  ];

  const [open, setOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full bg-white/85 backdrop-blur-md transition-[border-color,box-shadow] duration-300",
        scrolled ? "border-b border-border" : "border-b border-transparent"
      )}
    >
      <div className="mx-auto flex h-[3.75rem] max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        {inDocs ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="lg:hidden">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="overflow-y-auto p-4">
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
        ) : null}

        <Link href={landingBase} className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lvis-mark.svg" alt="" className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">LVIS AI</span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {nav.map((n) => {
            const active = n.isDocs && inDocs;
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-colors",
                  active
                    ? "bg-secondary font-semibold text-ink"
                    : "text-muted-foreground hover:bg-secondary hover:text-ink"
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <CommandPaletteTrigger />
          <Link
            href={localePath(pathname.includes("_not-found") ? "/" : pathname, otherLocale)}
            aria-label="Switch language"
            className="inline-flex h-9 items-center rounded-full border border-border px-3 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-ink"
          >
            {locale === "en" ? (
              <>
                <span className="text-ink">EN</span>
                <span className="mx-1 text-muted-foreground/60">|</span>
                <span>KO</span>
              </>
            ) : (
              <>
                <span className="text-ink">KO</span>
                <span className="mx-1 text-muted-foreground/60">|</span>
                <span>EN</span>
              </>
            )}
          </Link>
          <Button asChild size="sm" variant="default" className="hidden sm:inline-flex">
            <Link href={`${landingBase}#download`}>{strings.downloadApp}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
