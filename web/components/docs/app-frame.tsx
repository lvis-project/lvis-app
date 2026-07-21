"use client";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Toc } from "./toc";

/** Routes that render full-bleed (no docs sidebar/TOC). */
const IMMERSIVE = new Set<string>(["/", "/en"]);

/**
 * Chooses the layout from the route: immersive (full-bleed marketing canvas) for
 * the landing page, or the 3-column reading shell for every doc route.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // usePathname() carries a trailing slash on the client under trailingSlash:true
  // (e.g. "/en/") but not during prerender ("/en") — normalize before matching,
  // or the EN landing hydrates into the reading shell (sidebar) by mistake.
  const immersive = IMMERSIVE.has(pathname.replace(/\/$/, "") || "/");

  if (immersive) {
    return (
      <main id="docs-main" className="relative">
        {children}
      </main>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] gap-10 px-4 sm:px-6">
      <aside className="sticky top-[3.75rem] hidden h-[calc(100dvh-3.75rem)] w-64 shrink-0 overflow-y-auto py-8 lg:block">
        <Sidebar />
      </aside>
      <main
        id="docs-main"
        className="prose-doc min-w-0 flex-1 py-12 sm:py-14 lg:py-16 xl:max-w-[820px]"
      >
        {children}
      </main>
      <Toc />
    </div>
  );
}
