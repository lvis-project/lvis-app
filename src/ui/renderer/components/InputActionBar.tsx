/**
 * InputActionBar — the single unified action bar inside the composer input box.
 *
 * History: this absorbs the former BottomActionRow (shortcuts / thinking /
 * cancel / send) so there is ONE action bar rather than a top action row plus a
 * separate bottom turn-control row (L24246). Layout:
 *
 *   ACTION ROW (single line):
 *     LEADING:  [⌘ slash/command picker] → [persona] → [attach]
 *     TRAILING: [? shortcuts] → [thinking] → [(cancel — busy only)] → [send]
 *
 *   STATUS SUB-ROW (bottom, compact single line):
 *     [● active] · [vendor · model] · [permission — per-mode TEXT color] · [ring]
 *
 * The window StatusBar is notifications-only after this change; the persistent
 * model / permission / active cells moved here. The TokenProgressRing widget
 * lives at the END of this sub-row (after permission); the % / cost detail is
 * surfaced on the ring's hover/click — there is no separate context-percent
 * text cell.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md
 */
import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { HelpCircle, Paperclip, Square, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PluginEntry } from "./PluginGridButton.js";
import { SlashPicker, type QuickAction } from "./SlashPicker.js";
import { ThinkingButton } from "./ThinkingButton.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../shared/assistant-context-menu.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { InputStatusRow, PermissionModeVariant } from "../hooks/use-input-status-row.js";

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
  // Status sub-row — token progress ring (composed by the caller: ring + cost
  // detail). Rendered at the END of the status sub-row, after the permission
  // cell. The ring surfaces %/cost on hover/click.
  ringSlot: ReactNode;
  // Leading — attachment picker (single unified button, no count badge —
  // count lives on the in-composer chip).
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

  // Trailing — turn controls (merged from the former BottomActionRow).
  /** LLM busy (streaming / 도구 실행) — toggles the inline cancel button. */
  isBusy: boolean;
  /** Send button disabled — text 비고 첨부 없으면 true. */
  isSendDisabled: boolean;
  /** Send click (= Enter). intent capture lives in the caller. */
  onSend: () => void;
  /** ESC cancel = LLM abort (큐 보존). Rendered only while busy. */
  onCancel: () => void;
  /** Thinking (extended reasoning) toggle + depth, before Send. */
  enableThinkingChat: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;

  // Status sub-row.
  /** Resolved model / permission / active fields (from useInputStatusRow). */
  statusRow: InputStatusRow;
  /** Opens Settings → LLM when the model cell is clicked. */
  onOpenModelSettings?: () => void;
  /** Opens Settings → Permissions when the permission cell is clicked. */
  onOpenPermissions?: () => void;
}

function attachButtonLabel(
  disabled: boolean,
  reason: "limit" | "no-api-key",
): string {
  if (!disabled) return t("inputActionBar.attachEnabled");
  if (reason === "no-api-key") return t("inputActionBar.attachDisabledNoApiKey");
  return t("inputActionBar.attachDisabledLimit");
}

const PERMISSION_LABEL_KEYS: Record<PermissionModeVariant, string> = {
  default: "permissionModeBadge.labelDefault",
  strict: "permissionModeBadge.labelStrict",
  auto: "permissionModeBadge.labelAuto",
  allow: "permissionModeBadge.labelAllow",
  unknown: "permissionModeBadge.labelUnknown",
};

// Per-mode TEXT color (no pill/outline) — reuses the PermissionModeBadge color
// tokens, rendered as bare text per the directive ("알약모양 말고 모델 명과
// 동일하게 텍스트로 표기", "글씨 색으로 현재 상태 표현하고 아웃라인 없이").
const PERMISSION_TEXT_COLOR: Record<PermissionModeVariant, string> = {
  default: "text-info",
  strict: "text-destructive",
  auto: "text-warning",
  allow: "text-success",
  unknown: "text-muted-foreground",
};

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
  isBusy,
  isSendDisabled,
  onSend,
  onCancel,
  enableThinkingChat,
  onToggleThinking,
  statusRow,
  onOpenModelSettings,
  onOpenPermissions,
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
      className="flex min-w-0 flex-col gap-1"
    >
      {/* ── ACTION ROW ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pt-2">
        {/* Leading cluster — [command/slash] → [persona] → [attach].
            The token ring moved to the status sub-row (after permission). */}
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
        </div>

        {/* Trailing cluster — turn controls (? · thinking · cancel · send). */}
        <div
          className="ml-auto flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1.5 overflow-hidden pr-2"
          data-testid="iab-trailing"
        >
          <ShortcutsButton />
          <ThinkingButton enabled={enableThinkingChat} onToggle={onToggleThinking} />
          {isBusy && (
            <button
              type="button"
              onClick={onCancel}
              data-testid="composer-cancel-button"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
              title={t("bottomActionRow.cancelButton")}
              aria-label={t("bottomActionRow.cancelButton")}
            >
              <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
            </button>
          )}
          <Button
            type="button"
            onClick={onSend}
            disabled={isSendDisabled}
            data-testid="composer-send-button"
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 px-3 text-xs font-semibold"
          >
            <span>{t("bottomActionRow.sendButton")}</span>
            <KbdInverse>⏎</KbdInverse>
          </Button>
        </div>
      </div>

      {/* ── STATUS SUB-ROW ──────────────────────────────────────────── */}
      <StatusSubRow
        statusRow={statusRow}
        ringSlot={ringSlot}
        onOpenModelSettings={onOpenModelSettings}
        onOpenPermissions={onOpenPermissions}
      />
    </div>
  );
}

/**
 * Status sub-row — compact single line at the bottom of the unified bar:
 *   [● active] · [vendor · model] · [permission — per-mode text color] · [ring]
 *
 * Permission is plain text colored per-mode (no pill/outline). The
 * TokenProgressRing widget sits at the END (after permission); the usage % /
 * cost detail is surfaced on the ring's hover/click — there is no separate
 * context-percent text cell.
 */
function StatusSubRow({
  statusRow,
  ringSlot,
  onOpenModelSettings,
  onOpenPermissions,
}: {
  statusRow: InputStatusRow;
  ringSlot: ReactNode;
  onOpenModelSettings?: () => void;
  onOpenPermissions?: () => void;
}) {
  const { t } = useTranslation();
  const { active, vendorModel, permissionMode, pendingApprovals } = statusRow;
  const permissionLabel = t(PERMISSION_LABEL_KEYS[permissionMode]);
  const permissionText =
    pendingApprovals > 0
      ? `${permissionLabel}${t("permissionModeBadge.pendingTextCount", { count: pendingApprovals })}`
      : permissionLabel;

  return (
    <div
      data-testid="iab-status-row"
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pb-1.5 text-[11px] text-muted-foreground"
    >
      {/* REVERSED row order (user): ring on the LEFT, then a right-aligned
          cluster [permission · vendor·model · active-dot] with the dot at the
          far right. */}

      {/* Token progress ring — now LEFTMOST. */}
      <span className="shrink-0" data-testid="iab-status-ring">
        {ringSlot}
      </span>

      {/* Permission — plain text, per-mode color; ml-auto pushes the trailing
          cluster (permission · model · dot) to the right edge. */}
      {onOpenPermissions ? (
        <button
          type="button"
          onClick={onOpenPermissions}
          data-testid="iab-status-permission"
          data-mode={permissionMode}
          className={`ml-auto shrink-0 truncate hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${PERMISSION_TEXT_COLOR[permissionMode]}`}
          title={permissionText}
        >
          {permissionText}
        </button>
      ) : (
        <span
          data-testid="iab-status-permission"
          data-mode={permissionMode}
          className={`ml-auto shrink-0 truncate ${PERMISSION_TEXT_COLOR[permissionMode]}`}
          title={permissionText}
        >
          {permissionText}
        </span>
      )}

      <span className="shrink-0 opacity-30" aria-hidden="true">·</span>

      {/* Vendor · model. */}
      {onOpenModelSettings ? (
        <button
          type="button"
          onClick={onOpenModelSettings}
          data-testid="iab-status-model"
          className="min-w-0 shrink truncate text-left hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={vendorModel}
        >
          {vendorModel}
        </button>
      ) : (
        <span data-testid="iab-status-model" className="min-w-0 shrink truncate" title={vendorModel}>
          {vendorModel}
        </span>
      )}

      <span className="shrink-0 opacity-30" aria-hidden="true">·</span>

      {/* Active-state dot — now TRAILING (far right). */}
      <span
        data-testid="iab-status-active-dot"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-success" : "bg-muted-foreground/(--opacity-muted)"}`}
        aria-label={active ? t("inputActionBar.statusActive") : t("inputActionBar.statusInactive")}
      />
    </div>
  );
}

/**
 * Helper to capture user keyboard intent snapshot from window.lvisApi.
 * The bar itself does not know the intent → the caller wraps the send.
 */
export function makeBottomActionSendHandler(
  baseSend: (intent: UserKeyboardIntentSnapshot) => void,
): () => void {
  return () => {
    const api = (globalThis as typeof globalThis & {
      window?: { lvisApi?: { captureUserKeyboardIntent?: () => UserKeyboardIntentSnapshot } };
    }).window?.lvisApi;
    const intent = api?.captureUserKeyboardIntent?.() ?? {
      inputOrigin: "user-keyboard",
      token: "",
    };
    baseSend(intent);
  };
}

/**
 * ShortcutsButton — fixed-size "?" affordance. Hover surfaces a "단축키"
 * tooltip; click opens a tidy popover listing every composer keybinding.
 * Fixed form (h-[26px] w-[26px]) keeps the action row layout stable.
 */
function ShortcutsButton() {
  const { t } = useTranslation();
  const label = t("bottomActionRow.shortcuts");
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="composer-shortcuts-button"
              aria-label={label}
              className="h-[26px] w-[26px] shrink-0 text-muted-foreground"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-56 p-2" data-testid="composer-shortcuts-popover">
        <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">{label}</div>
        <div className="flex flex-col gap-0.5">
          <ShortcutRow keys={["⏎"]} label={t("bottomActionRow.shortcutSend")} />
          <ShortcutRow keys={["⇧⏎"]} label={t("bottomActionRow.shortcutNewline")} />
          <ShortcutRow keys={["⌘⏎"]} label={t("bottomActionRow.shortcutImmediate")} />
          <ShortcutRow keys={["Esc"]} label={t("bottomActionRow.shortcutCancel")} />
          <ShortcutRow keys={["⌘K"]} label={t("bottomActionRow.shortcutPalette")} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded px-1 py-0.5 text-[11px]">
      <span className="text-foreground">{label}</span>
      <span className="inline-flex items-center gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border border-b-2 bg-muted px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

function KbdInverse({ children }: { children: ReactNode }) {
  // theme tokens 만 사용 (theme-snapshot.test.tsx 가 black/white 직접 참조 금지).
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-primary-foreground/(--opacity-muted) border-b-2 bg-primary-foreground/(--opacity-soft) px-1 font-mono text-[10px] text-primary-foreground">
      {children}
    </kbd>
  );
}
