/**
 * SlashPicker — the composer's command button.
 *
 * The rows are the OS's own menu, not a panel drawn in the page. A menu of
 * commands is what the platform already draws well: it escapes the window, it
 * scrolls and keyboard-navigates the way every other menu on the machine does,
 * and it costs no layout inside a composer that is already tight.
 *
 * What it gives up is type-to-filter, which a native menu cannot do — items are
 * fixed when the menu pops, and the OS takes the key grab, so keystrokes never
 * reach the page to refine anything. That surface still exists and is untouched:
 * typing "/" in the composer opens `InlineSlashMenu`, which filters as you type.
 * This button is the browse path; "/" is the search path.
 *
 * Everything still runs through the same callbacks: slash commands are inserted
 * as text ("/cmd "), shortcuts run their action, plugins open their view.
 */
import { useCallback, useEffect, useRef } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { PluginEntry } from "./PluginGridButton.js";
import { useTranslation } from "../../../i18n/react.js";

import type { McpPromptEntry } from "./slash-picker-data.js";
import { buildComposerMenuSections } from "./slash-picker-data.js";
import { loadSlashPickerRuntime } from "../hooks/use-slash-picker-runtime.js";
import { useNativeMenu } from "../hooks/use-native-context-menu.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

export interface SlashPickerProps {
  /** Installed plugins — surfaced as their own submenu. */
  plugins: PluginEntry[];
  /** Open a plugin's view by its view key. */
  onSelectPlugin: (viewKey: string) => void;
  /** Insert a slash command at the caret; receives the trailing space e.g. "/help ". */
  onInsert: (cmd: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
  /** Controlled open state — raised externally (e.g. Cmd/Ctrl+K). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SlashPicker({
  plugins,
  onSelectPlugin,
  onInsert,
  onRunMcpPrompt,
  open,
  onOpenChange,
}: SlashPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const showMenu = useNativeMenu();

  const openMenu = useCallback(async () => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    // The trigger is the button being clicked, and ⌘K raises that same button,
    // so there is no path where the rect is missing. If it ever is, the composer
    // went away under us: opening nothing is right, drawing the menu in the
    // window's corner is not.
    if (!anchor) return;
    try {
      // Read at click time rather than held open in every mounted composer: the
      // menu is built and popped in one call, so what it draws is what is
      // connected now, and a tile that never opens it pays nothing.
      const runtime = await loadSlashPickerRuntime();
      const sections = buildComposerMenuSections({
        plugins,
        mcpTools: runtime.mcpTools,
        mcpPrompts: runtime.mcpPrompts,
        skills: runtime.skills,
        onInsert,
        onSelectPlugin,
        onRunMcpPrompt,
      });
      // The menu drops from the button's bottom-left, the way the panel did.
      const shown = await showMenu({ x: anchor.left, y: anchor.bottom }, sections);
      if (!shown) console.error("[lvis] composer menu was refused; nothing opened");
    } catch (err) {
      // Reading the runtime crosses IPC and can reject. Saying so beats a button
      // that looks broken, and the flag below must be released either way.
      console.error("[lvis] composer menu could not be built", err);
    } finally {
      // `popup` returns as soon as the menu is on screen, and the OS owns it from
      // there — there is no close event to wait for, so the controlled flag is
      // released now. It exists to let ⌘K raise the menu, not to track it. Left
      // set, the next ⌘K would only toggle it back off and look swallowed.
      onOpenChange(false);
    }
  }, [plugins, onInsert, onSelectPlugin, onRunMcpPrompt, showMenu, onOpenChange]);

  // ⌘K sets the flag; raising the menu is the same path as a click. This runs
  // in an effect, not the render body: a render can be started and discarded,
  // and a discarded render must not pop a menu nor leave a ref claiming it did.
  // The ref guards the window between popping and the flag being released, in
  // which any unrelated re-render would otherwise pop a second menu.
  const openingRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openingRef.current = false;
      return;
    }
    if (openingRef.current) return;
    openingRef.current = true;
    void openMenu();
  }, [open, openMenu]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="h-7 w-7 shrink-0 bg-input-bar p-0"
          aria-label={t("slashPicker.ariaLabel")}
          aria-haspopup="menu"
          data-testid={TEST_IDS.slashPickerTrigger}
          // SpotlightTour anchor: step 3 of the `first-boot-essentials`
          // scenario highlights this toggle, see `default-tour-scenarios.ts`.
          data-tour-anchor="command-palette-toggle"
          onClick={() => { void openMenu(); }}
        >
          <CommandIcon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t("slashPicker.shortcutHint")}</TooltipContent>
    </Tooltip>
  );
}
