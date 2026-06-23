import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Paperclip, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PluginEntry } from "./PluginGridButton.js";
import { SlashPicker, type QuickAction } from "./SlashPicker.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../shared/assistant-context-menu.js";

export interface InputActionBarProps {
  // Leading — slash/command picker (folds plugins/mcp/skills inside its own
  // categories, so there is no separate plugin grid button: the sidebar already
  // surfaces plugins + marketplace).
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsertSlashCommand: (cmd: string) => void;
  commandActions: QuickAction[];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  // Leading — token progress ring (composed by the caller: ring + cost detail).
  ringSlot: ReactNode;
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
  // Leading — role preset (persona), placed before the ring.
  rolePresets: RolePreset[];
  activePreset: RolePreset | null | undefined;
  activePresetId: string;
  onSelectPreset: (id: string) => void;
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
  onInsertSlashCommand,
  commandActions,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  ringSlot,
  onAttach,
  attachDisabled,
  attachDisabledReason = "limit",
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
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
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pt-2"
    >
      {/* Leading cluster — order: [command/slash picker] → [persona] → [ring]. */}
      <div className="flex shrink-0 flex-nowrap items-center gap-0.5" data-testid="iab-leading">
        <SlashPicker
          actions={commandActions}
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          onInsert={onInsertSlashCommand}
          open={commandPopoverOpen}
          onOpenChange={onCommandPopoverOpenChange}
        />

        {/* Native persona context menu. Electron draws this outside the
            renderer DOM, so submenus are not clipped by the chat pane. */}
        <Button
          variant="outline"
          size="sm"
          className="relative h-[26px] w-[26px] shrink-0 bg-input-bar p-0"
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

        {/* Token progress ring — square, hover=percent, click=detail (+cost). */}
        {ringSlot}
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
          className="h-[26px] w-[26px] shrink-0 bg-input-bar p-0"
          title={attachButtonLabel(attachDisabled, attachDisabledReason)}
          aria-label={attachButtonLabel(attachDisabled, attachDisabledReason)}
        >
          <Paperclip className="h-3.5 w-3.5" />
        </Button>

        {/* Permission/approval status moved to the bottom StatusBar (after the
            model name, plain text). Thinking moved to the BottomActionRow. */}
      </div>
    </div>
  );
}
