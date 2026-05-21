import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Paperclip, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";
import { CommandPopover, type QuickAction } from "./CommandPopover.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AssistantAgentSummary, AssistantSkillSummary } from "../../../shared/assistant-context.js";
import type { AssistantContextMenuAction } from "../../../shared/assistant-context-menu.js";

export interface InputActionBarProps {
  // Leading
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onRefreshPlugins?: () => void;
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
  onRefreshPlugins,
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
  const assistantMenuRequestIdRef = useRef<string | null>(null);
  const hasAssistantContext =
    !!activeAgentName ||
    activeSkillNames.length > 0 ||
    (!!activePreset && !activePreset.isDefault);
  const assistantTitle = [
    activeAgentName ? `Agent: ${activeAgentName}` : "",
    activeSkillNames.length > 0 ? `Skills: ${activeSkillNames.join(", ")}` : "",
    activePreset && !activePreset.isDefault ? `Persona: ${activePreset.name}` : "",
  ].filter(Boolean).join(" / ") || "Agent, skill, persona 선택";
  const toggleSkill = useCallback((name: string) => {
    onChangeSkillNames((current) => (
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
    ));
  }, [onChangeSkillNames]);

  const handleAssistantContextAction = useCallback((action: AssistantContextMenuAction) => {
    if (action.requestId !== assistantMenuRequestIdRef.current) return;
    assistantMenuRequestIdRef.current = null;
    switch (action.kind) {
      case "agent":
        if (typeof action.name === "string") onSelectAgent(action.name);
        return;
      case "skill-toggle":
        if (typeof action.name === "string") toggleSkill(action.name);
        return;
      case "skills-clear":
        onChangeSkillNames(() => []);
        return;
      case "persona":
        if (typeof action.id === "string") onSelectPreset(action.id);
        return;
      default:
        return;
    }
  }, [onChangeSkillNames, onSelectAgent, onSelectPreset, toggleSkill]);

  useEffect(() => {
    return window.lvis?.ui?.onAssistantContextAction?.(handleAssistantContextAction);
  }, [handleAssistantContextAction]);

  const openAssistantContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const nativeMenu = window.lvis?.ui?.showAssistantContextMenu;
    if (!nativeMenu) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const requestId =
      globalThis.crypto?.randomUUID?.() ??
      `assistant-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    assistantMenuRequestIdRef.current = requestId;
    void nativeMenu({
      requestId,
      x: Math.round(event.clientX || rect.left),
      y: Math.round(event.clientY || rect.top),
      agents: agentOptions.map((agent) => ({ name: agent.name })),
      skills: skillOptions.map((skill) => ({ name: skill.name })),
      personas: rolePresets.map((preset) => ({ id: preset.id, name: preset.name })),
      activeAgentName,
      activeSkillNames,
      activePersonaId: activePresetId,
    });
  }, [activeAgentName, activePresetId, activeSkillNames, agentOptions, rolePresets, skillOptions]);

  return (
    <div
      data-testid="input-action-bar"
      // Tutorial-C SpotlightTour anchor (PR #983 follow-up). Step 2 of
      // `first-boot-essentials` pins to this action-bar root, see
      // `default-tour-scenarios.ts`.
      data-tour-anchor="input-action-bar"
      className="flex min-w-0 items-center gap-2 px-3 pt-2"
    >
      {/* Leading cluster */}
      <div className="flex shrink-0 items-center gap-0.5" data-testid="iab-leading">
        <PluginGridButton
          plugins={plugins}
          onSelect={onSelectPlugin}
          onRefreshPlugins={onRefreshPlugins}
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
      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden pr-2" data-testid="iab-trailing">
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

        {/* v6: 권한 + 권한 큐 승인 chip — 가변 폭 영역. 오른쪽 고정 버튼들이
            밀리지 않도록 slot 자체만 shrink/clip 되게 둔다. */}
        {(permissionSlot || approvalSlot) && (
          <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden" data-testid="iab-permission-slots">
            {permissionSlot && <div className="min-w-0 overflow-hidden">{permissionSlot}</div>}
            {approvalSlot && <div className="min-w-0 overflow-hidden">{approvalSlot}</div>}
          </div>
        )}

        {/* Native assistant context menu. Electron draws this outside the
            renderer DOM, so submenus are not clipped by the chat pane. */}
        <Button
          variant="outline"
          size="sm"
          className="relative h-7 w-7 shrink-0 bg-input-bar p-0"
          title={assistantTitle}
          aria-label={assistantTitle}
          data-testid="iab-assistant-context-button"
          onClick={openAssistantContextMenu}
          onContextMenu={openAssistantContextMenu}
        >
          <User className="h-3.5 w-3.5" />
          {hasAssistantContext && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-action-view" />
          )}
        </Button>

        {/* Thinking checkbox — UI-only for now (vendorSupports gate removed
            so the toggle is always visible regardless of LLM model). Toggle
            wires through to existing onToggleThinking; on vendors that
            don't support thinking the engine simply ignores the flag. */}
        <Label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-muted-foreground">
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
