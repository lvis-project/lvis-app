import { ChevronDown, Paperclip, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { TokenProgressRing } from "./TokenProgressRing.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import { SlashCommandButton } from "./SlashCommandButton.js";
import type { RolePreset } from "../../../data/role-presets.js";

export interface InputActionBarProps {
  // Leading
  usedTokens: number;
  contextBudget: number;
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsertSlashCommand: (cmd: string) => void;
  // Trailing — attachment picker (single unified button, no count badge —
  // count lives on the in-composer chip)
  onAttach: () => void | Promise<void>;
  attachDisabled: boolean;
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
  onAttach,
  attachDisabled,
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
        {/* Single unified attach button — images, files, anything except the
            deny-listed dangerous extensions. The chip count badge lives on
            the inline composer chip (n/5), not here. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onAttach()}
          disabled={attachDisabled}
          data-testid="iab-attach-button"
          className="h-7 w-7 p-0"
          title={attachDisabled ? "첨부 한도 도달" : "파일/이미지 첨부 (최대 5개)"}
        >
          <Paperclip className="h-3.5 w-3.5" />
        </Button>

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
