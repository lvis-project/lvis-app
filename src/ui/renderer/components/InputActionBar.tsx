import { ChevronDown, Paperclip, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";
import { CommandPopover, type QuickAction } from "./CommandPopover.js";
import type { RolePreset } from "../../../data/role-presets.js";

export interface InputActionBarProps {
  // Leading
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  installingPlugins?: ReadonlyMap<string, InstallPhase>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
  onInsertSlashCommand: (cmd: string) => void;
  commandActions: QuickAction[];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  // Trailing — attachment picker (single unified button, no count badge —
  // count lives on the in-composer chip)
  onAttach: () => void | Promise<void>;
  attachDisabled: boolean;
  /**
   * Why the attach button is disabled, used to surface a context-specific
   * tooltip. Defaults to "limit" — useful when the caller only wires the
   * 5-cap path. Pass "no-api-key" or "context-overflow" for the other
   * gating cases so users see the actual blocker, not a misleading
   * "한도 도달" message.
   */
  attachDisabledReason?: "limit" | "no-api-key" | "context-overflow";
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

function attachButtonLabel(
  disabled: boolean,
  reason: "limit" | "no-api-key" | "context-overflow",
): string {
  if (!disabled) return "파일/이미지 첨부 (최대 5개)";
  if (reason === "no-api-key") return "첨부 비활성 — API 키 설정 후 사용 가능";
  if (reason === "context-overflow")
    return "첨부 비활성 — 컨텍스트 한도, 자동 압축 후 사용 가능";
  return "첨부 비활성 — 5/5 한도 도달";
}

export function InputActionBar({
  plugins,
  onSelectPlugin,
  installingPlugins,
  onOpenMarketplace,
  marketplaceUrlReady,
  onInsertSlashCommand,
  commandActions,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  onAttach,
  attachDisabled,
  attachDisabledReason = "limit",
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
  vendorSupportsThinking,
  enableThinkingChat,
  onToggleThinking,
}: InputActionBarProps) {
  return (
    <div data-testid="input-action-bar" className="flex min-w-0 items-center justify-between gap-2 px-3 pt-2">
      {/* Leading cluster */}
      <div className="flex min-w-0 items-center gap-0.5" data-testid="iab-leading">
        <PluginGridButton
          plugins={plugins}
          onSelect={onSelectPlugin}
          installingPlugins={installingPlugins}
          onOpenMarketplace={onOpenMarketplace}
          marketplaceUrlReady={marketplaceUrlReady}
        />
        <CommandPopover
          actions={commandActions}
          onInsert={onInsertSlashCommand}
          open={commandPopoverOpen}
          onOpenChange={onCommandPopoverOpenChange}
        />
      </div>

      {/* Trailing cluster */}
      <div className="flex min-w-0 shrink-0 items-center gap-1 pr-2" data-testid="iab-trailing">
        {/* Single unified attach button — images, files, anything except the
            deny-listed dangerous extensions. The chip count badge lives on
            the inline composer chip (n/5), not here. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onAttach()}
          disabled={attachDisabled}
          data-testid="iab-attach-button"
          className="h-7 w-7 p-0"
          title={attachButtonLabel(attachDisabled, attachDisabledReason)}
          aria-label={attachButtonLabel(attachDisabled, attachDisabledReason)}
        >
          <Paperclip className="h-3.5 w-3.5" />
        </Button>

        {/* Role preset dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 max-w-28 gap-1 bg-input-bar text-[11px]"
              title="역할 프리셋 선택"
            >
              <User className="h-3 w-3" />
              <span className="min-w-0 truncate">{activePreset?.name ?? "기본"}</span>
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

        {/* Thinking checkbox — UI-only for now (vendorSupports gate removed
            so the toggle is always visible regardless of LLM model). Toggle
            wires through to existing onToggleThinking; on vendors that
            don't support thinking the engine simply ignores the flag. */}
        <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
          <Checkbox
            aria-label="Thinking"
            className="h-3.5 w-3.5 rounded-[2px] bg-background data-[state=unchecked]:bg-background data-[state=checked]:bg-primary"
            checked={enableThinkingChat}
            onCheckedChange={(checked) => void onToggleThinking(checked === true)}
          />
          <span className="text-[11px]">Thinking</span>
        </label>
      </div>
    </div>
  );
}
