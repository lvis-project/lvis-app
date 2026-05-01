import { ChevronDown, Paperclip, User, X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { TokenProgressRing } from "./TokenProgressRing.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import { SlashCommandButton } from "./SlashCommandButton.js";
import type { RolePreset } from "../../../data/role-presets.js";

interface IndexedDoc {
  id: string;
  name: string;
}

export interface InputActionBarProps {
  // Leading
  usedTokens: number;
  contextBudget: number;
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsertSlashCommand: (cmd: string) => void;
  // Trailing — paperclip
  attachedDocs: Array<{ id: string; name: string }>;
  onToggleAttachment: (doc: { id: string; name: string }) => void;
  onRemoveAttachment: (id: string) => void;
  indexedDocs: IndexedDoc[];
  docsLoading: boolean;
  onRefreshDocs: () => void | Promise<void>;
  docPopoverOpen: boolean;
  onDocPopoverOpenChange: (open: boolean) => void;
  // Trailing — role preset
  rolePresets: RolePreset[];
  activePreset: RolePreset | null | undefined;
  activePresetId: string;
  onSelectPreset: (id: string) => void;
  // Trailing — thinking
  vendorSupportsThinking: boolean;
  enableThinkingChat: boolean;
  onToggleThinking: (enabled: boolean) => void | Promise<void>;
}

export function InputActionBar({
  usedTokens,
  contextBudget,
  plugins,
  onSelectPlugin,
  onInsertSlashCommand,
  attachedDocs,
  onToggleAttachment,
  onRemoveAttachment,
  indexedDocs,
  docsLoading,
  onRefreshDocs,
  docPopoverOpen,
  onDocPopoverOpenChange,
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
  vendorSupportsThinking,
  enableThinkingChat,
  onToggleThinking,
}: InputActionBarProps) {
  return (
    <div data-testid="input-action-bar" className="flex items-center justify-between gap-2 px-3 pt-2">
      {/* Leading cluster */}
      <div className="flex items-center gap-2" data-testid="iab-leading">
        <TokenProgressRing used={usedTokens} budget={contextBudget} />
        <PluginGridButton plugins={plugins} onSelect={onSelectPlugin} />
        <SlashCommandButton onInsert={onInsertSlashCommand} />
      </div>

      {/* Trailing cluster */}
      <div className="flex items-center gap-2" data-testid="iab-trailing">
        {/* Paperclip attachment */}
        <Popover
          open={docPopoverOpen}
          onOpenChange={(o) => {
            onDocPopoverOpenChange(o);
            if (o) void onRefreshDocs();
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" title="문서 첨부">
              <Paperclip className="h-3 w-3" />
              {attachedDocs.length > 0 ? <span>{attachedDocs.length}</span> : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">인덱싱된 문서</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px]"
                onClick={() => void onRefreshDocs()}
              >
                새로고침
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {docsLoading ? (
                <div className="py-6 text-center text-xs text-muted-foreground">로딩 중...</div>
              ) : indexedDocs.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  문서가 없습니다. PageIndex 플러그인에서 먼저 인덱싱하세요.
                </div>
              ) : (
                <div className="space-y-1">
                  {indexedDocs.map((d) => {
                    const attached = attachedDocs.some((a) => a.id === d.id);
                    return (
                      <button
                        key={d.id}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted ${attached ? "bg-muted" : ""}`}
                        onClick={() => onToggleAttachment(d)}
                      >
                        <input type="checkbox" checked={attached} readOnly className="h-3 w-3" />
                        <span className="truncate">{d.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Role preset dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              title="역할 프리셋 선택"
            >
              <User className="h-3 w-3" />
              {activePreset?.name ?? "기본"}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {rolePresets.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onSelectPreset(p.id)}>
                <span className={activePresetId === p.id ? "font-semibold" : ""}>{p.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Thinking checkbox */}
        {vendorSupportsThinking && (
          <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={enableThinkingChat}
              onChange={(e) => void onToggleThinking(e.target.checked)}
            />
            <span className="text-[11px]">Thinking</span>
          </label>
        )}
      </div>
    </div>
  );
}

/** Attached doc chip strip — rendered below InputActionBar when there are attachments. */
export function AttachedDocChips({
  attachedDocs,
  onRemove,
}: {
  attachedDocs: Array<{ id: string; name: string }>;
  onRemove: (id: string) => void;
}) {
  if (attachedDocs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-1">
      {attachedDocs.map((d) => (
        <span
          key={d.id}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
        >
          <span>🗎 {d.name}</span>
          <button
            className="rounded-full p-0.5 hover:bg-background"
            onClick={() => onRemove(d.id)}
            title="첨부 해제"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
