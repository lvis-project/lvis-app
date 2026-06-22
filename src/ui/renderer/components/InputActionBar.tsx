import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Paperclip, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import { PluginGridButton, type PluginEntry } from "./PluginGridButton.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";
import { SlashPicker, type QuickAction } from "./SlashPicker.js";
import type { RolePreset } from "../../../data/role-presets.js";
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
   * 5-cap path. Pass "no-api-key" for auth gating so users see the actual
   * blocker, not a misleading "한도 도달" message.
   */
  attachDisabledReason?: "limit" | "no-api-key";
  // Trailing — role preset
  rolePresets: RolePreset[];
  activePreset: RolePreset | null | undefined;
  activePresetId: string;
  onSelectPreset: (id: string) => void;
  // v6: 환경 컨트롤 — 첨부와 페르소나 사이. caller (ChatView) 가 실제 컴포넌트
  // 인스턴스를 주입. InputActionBar 는 PermissionModeBadge /
  // DeferredApprovalChip 의 구체 타입에 의존 X (slot pattern).
  permissionSlot?: ReactNode;
  approvalSlot?: ReactNode;
}

function attachButtonLabel(
  disabled: boolean,
  reason: "limit" | "no-api-key",
): string {
  if (!disabled) return t("inputActionBar.attachEnabled");
  if (reason === "no-api-key") return t("inputActionBar.attachDisabledNoApiKey");
  return t("inputActionBar.attachDisabledLimit");
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
  permissionSlot,
  approvalSlot,
}: InputActionBarProps) {
  const { t } = useTranslation();
  const assistantMenuRequestIdRef = useRef<string | null>(null);
  const hasAssistantContext = !!activePreset && !activePreset.isDefault;
  const assistantTitle = [
    activePreset && !activePreset.isDefault ? `Persona: ${activePreset.name}` : "",
  ].filter(Boolean).join(" / ") || t("inputActionBar.selectPersona");

  const handleAssistantContextAction = useCallback((action: AssistantContextMenuAction) => {
    if (action.requestId !== assistantMenuRequestIdRef.current) return;
    assistantMenuRequestIdRef.current = null;
    if (action.kind === "persona" && typeof action.id === "string") onSelectPreset(action.id);
  }, [onSelectPreset]);

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
      personas: rolePresets.map((preset) => ({ id: preset.id, name: preset.name })),
      activePersonaId: activePresetId,
    });
  }, [activePresetId, rolePresets]);

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
        <SlashPicker
          actions={commandActions}
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
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
          variant="outline"
          size="sm"
          onClick={() => void onAttach()}
          disabled={attachDisabled}
          data-testid="iab-attach-button"
          className="h-7 w-7 shrink-0 bg-input-bar p-0"
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

        {/* Native persona context menu. Electron draws this outside the
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

        {/* Thinking moved out of this row into a dedicated ThinkingButton in
            the BottomActionRow (toggle + Low/Mid/High depth, before Send), so
            it no longer competes for space here and gains a depth control. */}
      </div>
    </div>
  );
}
