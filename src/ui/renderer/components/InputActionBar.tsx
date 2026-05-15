import type { ReactNode } from "react";
import { Bot, Check, Paperclip, Sparkles, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";
import { CommandPopover, type QuickAction } from "./CommandPopover.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AssistantAgentSummary, AssistantSkillSummary } from "../../../shared/assistant-context.js";

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
  agentOptions: AssistantAgentSummary[];
  skillOptions: AssistantSkillSummary[];
  activeAgentName: string;
  onSelectAgent: (name: string) => void;
  activeSkillNames: string[];
  onChangeSkillNames: (updater: (current: string[]) => string[]) => void;
  // Trailing — thinking
  vendorSupportsThinking: boolean;
  enableThinkingChat: boolean;
  onToggleThinking: (enabled: boolean) => void | Promise<void>;
  // v6: 환경 컨트롤 — 첨부와 페르소나 사이. caller (ChatView) 가 실제 컴포넌트
  // 인스턴스를 주입. InputActionBar 는 PermissionModeBadge /
  // DeferredApprovalChip 의 구체 타입에 의존 X (slot pattern).
  permissionSlot?: ReactNode;
  approvalSlot?: ReactNode;
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
  agentOptions,
  skillOptions,
  activeAgentName,
  onSelectAgent,
  activeSkillNames,
  onChangeSkillNames,
  vendorSupportsThinking,
  enableThinkingChat,
  onToggleThinking,
  permissionSlot,
  approvalSlot,
}: InputActionBarProps) {
  const activeSkillSet = new Set(activeSkillNames);
  const hasAssistantContext =
    !!activeAgentName ||
    activeSkillNames.length > 0 ||
    (!!activePreset && !activePreset.isDefault);
  const assistantTitle = [
    activeAgentName ? `Agent: ${activeAgentName}` : "",
    activeSkillNames.length > 0 ? `Skills: ${activeSkillNames.join(", ")}` : "",
    activePreset && !activePreset.isDefault ? `Persona: ${activePreset.name}` : "",
  ].filter(Boolean).join(" / ") || "Agent, skill, persona 선택";
  const toggleSkill = (name: string) => {
    onChangeSkillNames((current) => (
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
    ));
  };

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

        {/* v6: 권한 + 권한 큐 승인 chip — 첨부와 페르소나 사이. 환경 컨트롤
            slot, ChatView 가 실제 인스턴스 주입. */}
        {permissionSlot}
        {approvalSlot}

        {/* Assistant context dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="relative h-7 w-7 bg-input-bar p-0"
              title={assistantTitle}
              aria-label={assistantTitle}
            >
              <User className="h-3.5 w-3.5" />
              {hasAssistantContext && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-action-view" />
              )}
            </Button>
          </DropdownMenuTrigger>
          {/* Open upward from the input bar (trigger sits at the bottom of
              the chat surface). Without `side="top"` Radix defaults to
              "bottom" and the menu clips below the viewport; that also
              forces the Agent/Skills/Persona submenus to RTL-flip
              independently of the parent, making them visually detach. */}
          <DropdownMenuContent side="top" sideOffset={8} align="end" className="w-56">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Bot className="mr-2 h-3.5 w-3.5" />
                <span>Agent</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-60 overflow-y-auto">
                <DropdownMenuItem onClick={() => onSelectAgent("")}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${activeAgentName ? "opacity-0" : "opacity-100"}`} />
                  <span>기본 에이전트</span>
                </DropdownMenuItem>
                {agentOptions.length > 0 ? (
                  agentOptions.map((agent) => (
                    <DropdownMenuItem key={agent.name} onClick={() => onSelectAgent(agent.name)}>
                      <Check className={`mr-2 h-3.5 w-3.5 ${activeAgentName === agent.name ? "opacity-100" : "opacity-0"}`} />
                      <span className="min-w-0 truncate">{agent.name}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    <span className="text-muted-foreground">설치된 agent 없음</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                <span>Skills</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-60 overflow-y-auto">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onChangeSkillNames(() => []);
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${activeSkillNames.length === 0 ? "opacity-100" : "opacity-0"}`} />
                  <span>스킬 해제</span>
                </DropdownMenuItem>
                {skillOptions.length > 0 ? (
                  skillOptions.map((skill) => (
                    <DropdownMenuItem
                      key={skill.name}
                      onSelect={(event) => {
                        event.preventDefault();
                        toggleSkill(skill.name);
                      }}
                    >
                      <Check className={`mr-2 h-3.5 w-3.5 ${activeSkillSet.has(skill.name) ? "opacity-100" : "opacity-0"}`} />
                      <span className="min-w-0 truncate">{skill.name}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    <span className="text-muted-foreground">사용 가능한 skill 없음</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <User className="mr-2 h-3.5 w-3.5" />
                <span>Persona</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                {rolePresets.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => onSelectPreset(p.id)}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${activePresetId === p.id ? "opacity-100" : "opacity-0"}`} />
                    <span className={activePresetId === p.id ? "min-w-0 truncate font-semibold" : "min-w-0 truncate"}>{p.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Thinking checkbox — UI-only for now (vendorSupports gate removed
            so the toggle is always visible regardless of LLM model). Toggle
            wires through to existing onToggleThinking; on vendors that
            don't support thinking the engine simply ignores the flag. */}
        <Label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
          <Checkbox
            className="size-3.5"
            checked={enableThinkingChat}
            onCheckedChange={(checked) => void onToggleThinking(checked === true)}
          />
          <span className="text-[11px]">Thinking</span>
        </Label>
      </div>
    </div>
  );
}
