import { useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../../components/ui/command.js";

export interface CommandAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

export interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
}

/**
 * Cmd/Ctrl+K command palette. Extracted from App.tsx inline JSX to keep the
 * composition root focused on orchestration.
 */
export function CommandPaletteDialog({ open, onOpenChange, actions }: CommandPaletteDialogProps) {
  const [query, setQuery] = useState("");
  const filtered = actions.filter((a) => !query || a.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setQuery(""); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Command</DialogTitle>
          <DialogDescription>빠른 실행</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="검색..." value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>결과 없음</CommandEmpty>
            <CommandGroup heading="Actions">
              {filtered.map((a) => (
                <CommandItem
                  key={a.id}
                  onSelect={() => {
                    onOpenChange(false);
                    setQuery("");
                    void a.run();
                  }}
                >
                  <Search className="mr-2 h-4 w-4" />
                  {a.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
