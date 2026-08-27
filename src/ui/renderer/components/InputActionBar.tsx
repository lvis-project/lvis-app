/**
 * InputActionBar — the single unified action bar inside the composer input box.
 *
 * There is ONE action bar in the composer — shortcuts, thinking, cancel and
 * send live here rather than in a second turn-control row below it. Layout:
 *
 *   ACTION ROW (single line):
 *     LEADING:  [⌘ slash/command picker] → [persona] → [attach]
 *     TRAILING: [? shortcuts] → [thinking] → [send / stop — one button]
 *
 * The turn control is a SINGLE icon button, not a send button next to a
 * separate cancel button: it carries "stop" only while a run is in flight AND
 * the composer is empty, and reverts to "send" the moment anything is typed.
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
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowUp, Brain, Check, ChevronRight, HelpCircle, Lightbulb, Paperclip, Square, User } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PluginEntry } from "./PluginGridButton.js";
import { SlashPicker, type QuickAction } from "./SlashPicker.js";
import { ReasoningLevelControl, useReasoningLevel } from "./ReasoningSlider.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult } from "../types.js";
import { modelCardChoices, type ModelCardChoice } from "../hooks/use-settings.js";
import type { AppSettings } from "../types.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../shared/assistant-context-menu.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { McpPromptEntry } from "./slash-picker-data.js";
import type { InputStatusRow, PermissionModeVariant } from "../hooks/use-input-status-row.js";

export interface InputActionBarProps {
  // Leading — slash/command picker (folds plugins/mcp/skills inside its own
  // categories, so there is no separate plugin grid button: the sidebar already
  // surfaces plugins + marketplace).
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsertSlashCommand: (cmd: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
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


  attachDisabledReason?: "limit" | "no-api-key" | "subscription-unsupported" | "runtime-pending";
  attachDisabledSubscriptionProvider?: string;
  // Leading — role preset (persona), placed before the ring.
  rolePresets: RolePreset[];
  activePreset: RolePreset | null | undefined;
  activePresetId: string;
  onSelectPreset: (id: string) => void;

  // Trailing — turn controls (merged from the former BottomActionRow).

  isBusy: boolean;

  isSendDisabled: boolean;
  /**
   * Whether the composer holds anything sendable (draft text or an
   * attachment). Distinct from `!isSendDisabled`, which also folds in the
   * runtime blocks — this one is purely "does the user have something queued
   * up", and it is what flips the single turn-control button between send and
   * stop.
   */
  hasDraft: boolean;
  /** Send click (= Enter). intent capture lives in the caller. */
  onSend: () => void;

  onCancel: () => void;
  /** Thinking (extended reasoning) toggle + depth, before Send. */
  enableThinkingChat: boolean;
  /** Whether the selected runtime accepts this app-controlled reasoning setting. */
  reasoningAvailable?: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;

  // Status sub-row.
  /** Resolved model / permission / active fields (from useInputStatusRow). */
  statusRow: InputStatusRow;
  /** Workspace mode controls compact status-row model labeling. */
  appMode?: "chat" | "work";
  /** Opens Settings → LLM — the model card's way to the full catalogue. */
  onOpenModelSettings: () => void;
  /** Opens Settings → Permissions when the permission cell is clicked. */
  onOpenPermissions?: () => void;
  /** Opens the deferred approval queue dialog. Separate from permission settings. */
  onOpenApprovalQueue?: () => void;
}

function attachButtonLabel(
  disabled: boolean,
  reason: "limit" | "no-api-key" | "subscription-unsupported" | "runtime-pending",
  subscriptionProvider?: string,
): string {
  if (!disabled) return t("inputActionBar.attachEnabled");
  if (reason === "runtime-pending") {
    return t("subscriptionProvidersSection.statusChecking");
  }
  if (reason === "subscription-unsupported") {
    return t("app.subscriptionAttachmentUnsupported", {
      provider: subscriptionProvider ?? "subscription",
    });
  }
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


const PERMISSION_TEXT_COLOR: Record<PermissionModeVariant, string> = {
  default: "text-info",
  strict: "text-destructive",
  auto: "text-warning",
  allow: "text-success",
  unknown: "text-input-bar-placeholder",
};

export function InputActionBar({
  plugins,
  onSelectPlugin,
  onInsertSlashCommand,
  onRunMcpPrompt,
  commandActions,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  ringSlot,
  onAttach,
  attachDisabled,
  attachDisabledReason = "limit",
  attachDisabledSubscriptionProvider,
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
  isBusy,
  isSendDisabled,
  hasDraft,
  onSend,
  onCancel,
  enableThinkingChat,
  reasoningAvailable = true,
  onToggleThinking,
  statusRow,
  appMode = "work",
  onOpenModelSettings,
  onOpenPermissions,
  onOpenApprovalQueue,
}: InputActionBarProps) {
  const { t } = useTranslation();
  const assistantMenuRequestIdRef = useRef<string | null>(null);
  const showStop = isBusy && !hasDraft;
  const turnControlLabel = showStop
    ? t("bottomActionRow.cancelButton")
    : t("bottomActionRow.sendButton");
  // Stop is always actionable; send is not whenever `isSendDisabled` says so —
  // which covers BOTH "nothing to send" and the runtime blocks (no API key,
  // runtime unavailable). One flag drives the `disabled` attribute and the
  // quiet styling together, so the two can never disagree.
  const turnControlInert = !showStop && isSendDisabled;
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
      // SpotlightTour anchor. Step 2 of
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
            onRunMcpPrompt={onRunMcpPrompt}
            open={commandPopoverOpen}
            onOpenChange={onCommandPopoverOpenChange}
          />

          {/* Native persona context menu. Electron draws this outside the
              renderer DOM, so submenus are not clipped by the chat pane. */}
          <Button
            variant="outline"
            size="sm"
            className="relative h-[26px] w-[26px] shrink-0 border-input-bar-border bg-input-bar-subtle p-0 text-input-bar-action transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-action/(--opacity-subtle) hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
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
            className="h-[26px] w-[26px] shrink-0 border-input-bar-border bg-input-bar-subtle p-0 text-input-bar-action transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-action/(--opacity-subtle) hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
            title={attachButtonLabel(attachDisabled, attachDisabledReason, attachDisabledSubscriptionProvider)}
            aria-label={attachButtonLabel(attachDisabled, attachDisabledReason, attachDisabledSubscriptionProvider)}
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Trailing cluster — turn controls (? · thinking · send/stop). */}
        <div
          className="ml-auto flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1.5 overflow-hidden pr-2"
          data-testid="iab-trailing"
        >
          <ShortcutsButton />
          {/* Reasoning control moved to the status sub-row (between model and dot). */}
          {/* ONE turn-control button. The draft decides which verb it carries:
              anything typed (or attached) means the user's next action is
              "send", so it stays a send button even mid-run; an empty draft
              during a run leaves "stop" as the only useful action. Idle with an
              empty draft keeps the send glyph, disabled. ESC still cancels a
              run regardless of what the button currently shows.
              The label is the icon plus title/aria-label — the old
              "전송 + ⏎ keycap" pair rendered the keycap as an empty box
              (its background and its text both resolved to
              `primary-foreground`, so the glyph disappeared into the chip). */}
          <Button
            type="button"
            /* Quiet whenever it cannot act: a disabled SOLID button is a
               near-black disc at 50% opacity, which reads as a broken grey
               blob rather than "waiting". Inert it borrows the leading
               cluster's outline treatment, so an idle composer shows one calm
               row of controls; it goes solid the instant the button can
               actually do something. */
            variant={turnControlInert ? "outline" : "default"}
            onClick={showStop ? onCancel : onSend}
            disabled={turnControlInert}
            data-testid={showStop ? "composer-cancel-button" : "composer-send-button"}
            title={turnControlLabel}
            aria-label={turnControlLabel}
            className={
              "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full p-0 transition-transform duration-(--motion-fast) ease-(--motion-ease-standard) active:scale-90 focus-visible:ring-input-bar-focus motion-reduce:transition-none motion-reduce:active:scale-100 " +
              (turnControlInert
                ? "border-input-bar-border bg-input-bar-subtle text-input-bar-action"
                : "")
            }
          >
            {/* Keyed so the send↔stop swap is a crossfade on the SAME button,
                not an instant glyph substitution that reads as two buttons
                trading places. */}
            <span
              key={showStop ? "stop" : "send"}
              className="lvis-turn-control-glyph inline-flex items-center justify-center"
            >
              {showStop
                ? <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
                : <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />}
            </span>
          </Button>
        </div>
      </div>

      {/* ── STATUS SUB-ROW ──────────────────────────────────────────── */}
      <StatusSubRow
        statusRow={statusRow}
        appMode={appMode}
        ringSlot={ringSlot}
        onOpenModelSettings={onOpenModelSettings}
        onOpenPermissions={onOpenPermissions}
        onOpenApprovalQueue={onOpenApprovalQueue}
        enableThinkingChat={enableThinkingChat}
        reasoningAvailable={reasoningAvailable}
        onToggleThinking={onToggleThinking}
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
  appMode,
  ringSlot,
  onOpenModelSettings,
  onOpenPermissions,
  onOpenApprovalQueue,
  enableThinkingChat,
  reasoningAvailable,
  onToggleThinking,
}: {
  statusRow: InputStatusRow;
  appMode: "chat" | "work";
  ringSlot: ReactNode;
  onOpenModelSettings: () => void;
  onOpenPermissions?: () => void;
  onOpenApprovalQueue?: () => void;
  enableThinkingChat: boolean;
  reasoningAvailable: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { active, vendorModel, permissionMode, pendingApprovals } = statusRow;
  // Mode label ONLY — the pending-approval count is now its own separate
  // button before the permission cell (no longer appended to the label text).
  const permissionLabel = t(PERMISSION_LABEL_KEYS[permissionMode]);
  const displayModel = appMode === "chat" ? stripVendorPrefix(vendorModel) : vendorModel;

  return (
    <div
      data-testid="iab-status-row"
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pb-1.5 text-caption text-input-bar-placeholder"
    >
      {/* Status sub-row order (user): ring on the LEFT; then a right-aligned
          cluster — [대기 승인 N] · permission(mode only) · model ·
          추론 slider · active-dot. */}

      {/* Token progress ring — leftmost. */}
      <span className="shrink-0" data-testid="iab-status-ring">
        {ringSlot}
      </span>

      <div className="ml-auto flex min-w-0 flex-nowrap items-center gap-1.5">
        {/* Pending approvals — its OWN button, BEFORE the permission cell. */}
        {pendingApprovals > 0 && (
          <>
            {onOpenApprovalQueue ? (
              <button
                type="button"
                onClick={onOpenApprovalQueue}
                data-testid="iab-status-pending"
                className="shrink-0 rounded-full border border-warning px-1.5 tabular-nums text-warning transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
                title={t("permissionModeBadge.queueButtonLabel", {
                  pendingText: t("permissionModeBadge.pendingTextCount", { count: pendingApprovals }),
                })}
              >
                <span data-testid="permission-pending-badge">
                  {t("permissionModeBadge.queueLabelCount", { count: pendingApprovals })}
                </span>
              </button>
            ) : (
              <span
                data-testid="iab-status-pending"
                className="shrink-0 rounded-full border border-warning px-1.5 tabular-nums text-warning"
              >
                <span data-testid="permission-pending-badge">
                  {t("permissionModeBadge.queueLabelCount", { count: pendingApprovals })}
                </span>
              </span>
            )}
            <span className="shrink-0 opacity-30" aria-hidden="true">·</span>
          </>
        )}

        {/* Permission — mode label ONLY, per-mode color. */}
        {onOpenPermissions ? (
          <button
            type="button"
            onClick={onOpenPermissions}
            data-testid="iab-status-permission"
            data-mode={permissionMode}
            className={`shrink-0 truncate transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none ${PERMISSION_TEXT_COLOR[permissionMode]}`}
            title={permissionLabel}
          >
            {permissionLabel}
          </button>
        ) : (
          <span
            data-testid="iab-status-permission"
            data-mode={permissionMode}
            className={`shrink-0 truncate ${PERMISSION_TEXT_COLOR[permissionMode]}`}
            title={permissionLabel}
          >
            {permissionLabel}
          </span>
        )}

        <span className="shrink-0 opacity-30" aria-hidden="true">·</span>

        {/* Model — brain icon + compact label; chat mode hides vendor prefix.
            Clicking it, or the reasoning chip after it, opens the model card:
            the pinned models, the reasoning level, and the way to the full
            catalogue. Settings is one more click away, not the first thing a
            model click does. */}
        <ModelQuickPicker
          vendorModel={vendorModel}
          displayModel={displayModel}
          enableThinking={enableThinkingChat}
          reasoningAvailable={reasoningAvailable}
          onToggleThinking={onToggleThinking}
          onOpenModelSettings={onOpenModelSettings}
        />

        <span className="shrink-0 opacity-30" aria-hidden="true">·</span>

        {/* Active-state dot — trailing (far right). */}
        <span
          data-testid="iab-status-active-dot"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-success" : "bg-input-bar-placeholder/(--opacity-muted)"}`}
          aria-label={active ? t("inputActionBar.statusActive") : t("inputActionBar.statusInactive")}
        />
      </div>
    </div>
  );
}

/**
 * The model card: what the status row's model cell opens.
 *
 * It holds the three things a person changes mid-conversation — which
 * model to use (the current one, and the pinned ones), how deep to reason,
 * and, when neither is enough, the way to the full catalogue in Settings.
 * Pins come from the same list the settings chooser pins with, so the card
 * and the chooser cannot disagree about what is pinned; a pick persists at
 * once, the same way the chooser's does.
 *
 * The reasoning chip beside the model cell is a second way in, not a
 * second control: it shows the current level and opens this same card.
 */
function ModelQuickPicker({
  vendorModel,
  displayModel,
  enableThinking,
  reasoningAvailable,
  onToggleThinking,
  onOpenModelSettings,
}: {
  vendorModel: string;
  displayModel: string;
  enableThinking: boolean;
  reasoningAvailable: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;
  onOpenModelSettings: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The chip sits outside the card, so Radix would treat a click on it as
  // "outside" — dismiss, then the click reopens: a flicker. The card is told
  // the chip is not outside, and the chip toggles like the trigger does.
  // Whichever of the two opened the card gets focus back when it closes.
  const chipRef = useRef<HTMLButtonElement>(null);
  const openedByChipRef = useRef(false);
  const [choices, setChoices] = useState<ModelCardChoice[]>([]);
  const [anyPinned, setAnyPinned] = useState(true);
  const runtimeRef = useRef<string>("api");
  const { level, levelLabels, apply } = useReasoningLevel({ enabled: enableThinking, onToggle: onToggleThinking });

  // Read on open and follow the broadcast while open: a pin added in
  // Settings, or a pick made in another tile, shows up without reopening.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const take = (settings: AppSettings) => {
      if (cancelled) return;
      setChoices(modelCardChoices(settings.llm));
      setAnyPinned((settings.llm.pinnedModels ?? []).length > 0);
      runtimeRef.current = settings.llm.activeChatRuntime?.kind ?? "api";
    };
    const api = getApi();
    void api.getSettings().then(take).catch(() => { /* card stays as it was */ });
    const unsubscribe = api.onSettingsUpdated(take);
    return () => { cancelled = true; unsubscribe(); };
  }, [open]);

  const pick = async (choice: ModelCardChoice) => {
    if (choice.current) {
      setOpen(false);
      return;
    }
    const api = getApi();
    // The card closes only once the pick took. A refused or failed save
    // leaves it open with the current mark unmoved — the honest state.
    const saved = await api.updateSettings({
      llm: {
        provider: choice.vendor,
        vendors: { [choice.vendor]: { model: choice.modelId } },
      },
    });
    if (isIpcErrorResult(saved)) {
      console.warn("[lvis] model pick was refused: %s", saved.error);
      return;
    }
    // A pinned model is an API model, so picking one is also choosing the
    // API path when a subscription runtime was in use. That switch has its
    // own request — the settings patch refuses a runtime change on its own —
    // and it is the same one the settings chooser sends.
    if (runtimeRef.current !== "api") await api.subscriptionUseApiForChat();
    setOpen(false);
  };

  const reasoningLabel = t("bottomActionRow.reasoning");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="iab-status-model"
          onClick={() => { openedByChipRef.current = false; }}
          className="inline-flex min-w-0 shrink items-center gap-1 text-left transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
          title={vendorModel}
        >
          <Brain className="h-3 w-3 shrink-0 text-input-bar-placeholder" aria-hidden="true" />
          <span className="min-w-0 truncate">{displayModel}</span>
        </button>
      </PopoverTrigger>
      {reasoningAvailable ? (
        <>
          <span className="shrink-0 opacity-30" aria-hidden="true">·</span>
          <button
            type="button"
            ref={chipRef}
            data-testid="iab-status-reasoning"
            data-level={level}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${reasoningLabel}: ${levelLabels[level]}`}
            title={`${reasoningLabel}: ${levelLabels[level]}`}
            onClick={() => {
              openedByChipRef.current = !open;
              setOpen(!open);
            }}
            className={`flex shrink-0 cursor-pointer items-center gap-0.5 transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:text-input-bar-action focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none ${level > 0 ? "text-input-bar-action" : "text-input-bar-placeholder"}`}
          >
            <Lightbulb className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="shrink-0 tabular-nums">{levelLabels[level]}</span>
          </button>
        </>
      ) : null}
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-72 p-0"
        data-testid="model-quick-picker"
        onInteractOutside={(event) => {
          if (chipRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!openedByChipRef.current) return;
          event.preventDefault();
          chipRef.current?.focus();
        }}
      >
        <div className="px-3 pt-3 text-caption font-medium text-muted-foreground">
          {t("bottomActionRow.modelPickerModels")}
        </div>
        <ul className="max-h-56 overflow-y-auto px-1 py-1" role="listbox" aria-label={t("bottomActionRow.modelPickerModels")}>
          {choices.map((choice) => (
            <li key={`${choice.vendor}::${choice.modelId}`} role="option" aria-selected={choice.current}>
              <button
                type="button"
                onClick={() => void pick(choice)}
                data-testid={`model-quick-picker-option:${choice.vendor}:${choice.modelId}`}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent"
              >
                <span className="max-w-[7rem] shrink-0 truncate text-caption text-muted-foreground">{choice.vendorLabel}</span>
                <span className="min-w-0 flex-1 truncate">{choice.modelId}</span>
                {choice.current ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
        {anyPinned ? null : (
          <p className="px-3 pb-2 text-caption text-muted-foreground" data-testid="model-quick-picker-no-pins">
            {t("bottomActionRow.modelPickerNoPins")}
          </p>
        )}
        {reasoningAvailable ? (
          <div className="border-t border-border/(--opacity-medium) px-3 py-3" data-testid="model-quick-picker-reasoning">
            <div className="mb-2 text-caption font-medium text-muted-foreground">{reasoningLabel}</div>
            <ReasoningLevelControl level={level} levelLabels={levelLabels} apply={apply} label={reasoningLabel} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => { setOpen(false); onOpenModelSettings(); }}
          data-testid="model-quick-picker-more"
          className="flex w-full items-center justify-between border-t border-border/(--opacity-medium) px-3 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent"
        >
          <span>{t("bottomActionRow.modelPickerMore")}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverContent>
    </Popover>
  );
}

function stripVendorPrefix(vendorModel: string): string {
  const marker = " · ";
  const idx = vendorModel.indexOf(marker);
  if (idx < 0) return vendorModel;
  return vendorModel.slice(idx + marker.length);
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
              className="h-[26px] w-[26px] shrink-0 text-input-bar-action transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-subtle hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-56 p-2" data-testid="composer-shortcuts-popover">
        <div className="px-1 pb-1.5 text-caption font-medium text-muted-foreground">{label}</div>
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
    <div className="flex items-center justify-between gap-3 rounded px-1 py-0.5 text-caption">
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
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border border-b-2 bg-muted px-1 font-mono text-micro text-muted-foreground">
      {children}
    </kbd>
  );
}
