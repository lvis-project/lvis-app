"use client";
import * as React from "react";
import { Command } from "cmdk";
import { useRouter, usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { getSearchEntries, type SearchEntry } from "@/lib/search-index";
import { localeFromPathname } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

interface Ctx {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const PaletteContext = React.createContext<Ctx | null>(null);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <PaletteContext.Provider value={{ open, setOpen }}>
      {children}
      <CommandPalette open={open} setOpen={setOpen} />
    </PaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const ctx = React.useContext(PaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  return ctx;
}

function CommandPalette({ open, setOpen }: Ctx) {
  const router = useRouter();
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  const [query, setQuery] = React.useState("");

  const groups = React.useMemo(() => {
    const map = new Map<string, SearchEntry[]>();
    for (const e of getSearchEntries(locale)) {
      if (!map.has(e.group)) map.set(e.group, []);
      map.get(e.group)!.push(e);
    }
    return Array.from(map.entries());
  }, [locale]);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[min(96vw,640px)] max-h-[80vh] p-0">
        <DialogTitle className="sr-only">검색 및 빠른 이동</DialogTitle>
        <DialogDescription className="sr-only">
          페이지 제목과 설명에 대한 fuzzy 검색. ↑↓ 이동, Enter 선택, Esc 닫기.
        </DialogDescription>
        <Command label="docs search" shouldFilter={true}>
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={strings.searchPlaceholder}
              className="w-full bg-transparent text-[14.5px] text-ink outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground sm:inline">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto px-1.5 py-2">
            <Command.Empty className="px-3.5 py-6 text-center text-[13px] text-muted-foreground">
              결과 없음. 다른 키워드로 검색해 보세요.
            </Command.Empty>

            {groups.map(([group, entries]) => (
              <Command.Group
                key={group}
                heading={group}
                className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-teal-dark"
              >
                {entries.map((e) => (
                  <Command.Item
                    key={e.href}
                    value={`${e.title} ${e.snippet} ${(e.keywords ?? []).join(" ")} ${e.group}`}
                    onSelect={() => go(e.href)}
                    className="flex cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-[13.5px] data-[selected=true]:bg-teal/10 data-[selected=true]:text-ink"
                  >
                    <span className="font-semibold text-ink">{e.title}</span>
                    <span className="text-[12.5px] leading-snug text-muted-foreground">{e.snippet}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>

          <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ 이동 · Enter 선택 · Esc 닫기</span>
            <span>
              ⌘<kbd className="mx-0.5 rounded border border-border px-1 text-[10.5px]">K</kbd>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandPaletteTrigger() {
  const ctx = React.useContext(PaletteContext);
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  return (
    <button
      type="button"
      onClick={() => ctx?.setOpen(true)}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-[13px] text-muted-foreground transition hover:bg-secondary hover:text-ink"
      aria-label={strings.openSearch}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{strings.searchPlaceholder}</span>
      <kbd className="ml-1 hidden rounded border border-border bg-white px-1.5 py-0.5 font-mono text-[10.5px] sm:inline">⌘K</kbd>
    </button>
  );
}
