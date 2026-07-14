import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

/**
 * Install the OS-native editing menu for trusted BrowserWindow renderers.
 * Domain-specific menus use the allow-listed UI IPC bridge instead; this
 * listener deliberately reacts only to editable controls or selected text.
 */
export function installNativeEditContextMenu(contents: WebContents): void {
  contents.on("context-menu", (event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    if (!params.isEditable && !hasSelection) return;
    event.preventDefault();

    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        ]
      : [
          { role: "copy", enabled: params.editFlags.canCopy || hasSelection },
          { type: "separator" },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        ];

    const menu = Menu.buildFromTemplate(template);
    const window = BrowserWindow.fromWebContents(contents);
    menu.popup(window
      ? { window, x: params.x, y: params.y }
      : { x: params.x, y: params.y });
  });
}
