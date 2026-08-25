/**
 * The host's folder picker, offered to plugins.
 *
 * WHAT THIS IS, said precisely, because the obvious reading is wrong. A picker
 * looks like a grant — the user chooses a directory and the plugin gets it —
 * and it is not one. A confined plugin child's filesystem confinement is
 * DENY-ONLY on the read side: an ordinary user directory is on no deny list, so
 * the plugin could already read it. What the plugin could NOT do is find out
 * WHICH directory the user meant. This answers that and nothing else.
 *
 * The consequence is worth stating because it is what keeps the capability
 * small: a picked path carries no new reach. Writing to it is still `EPERM`
 * unless the child's envelope already granted it, and nothing here widens the
 * envelope. A plugin that needs to WRITE where the user pointed needs an
 * envelope grant (`out-of-process-plugin.ts`, `userChosenDirectory`), which is
 * a reviewed row in a host-owned table rather than a dialog.
 *
 * WHY THE PLUGIN CANNOT OWN THE DIALOG. `dialog` is an Electron main-process
 * API, and reaching it is ambient axis 2 in the routing SOT
 * (`plugins/isolation/out-of-process-plugins.ts`): a plugin that resolves
 * `electron` has main's whole surface, not the one method it wanted. Mediating
 * the method is what lets the plugin be routed out-of-process at all.
 *
 * ATTRIBUTION IS THE POINT OF THE TITLE. A native folder chooser appearing
 * unbidden says nothing about who asked for it. The title names the requesting
 * plugin, so the user's answer is an answer to a question they can attribute.
 */
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { t } from "../../i18n/index.js";

/** What one plugin gets back. A cancel is an ANSWER, not a failure. */
export interface PickFoldersResult {
  /** True when the user dismissed the chooser without picking. */
  readonly canceled: boolean;
  /** Absolute paths the OS reported. Empty whenever `canceled`. */
  readonly folders: readonly string[];
}

/** What the picker needs from the host it runs in. */
export interface PickFoldersDeps {
  /** The window the sheet attaches to, or `null` for an unparented dialog. */
  readonly parentWindow: () => BrowserWindow | null;
}

/**
 * One in-flight chooser per plugin.
 *
 * A modal chooser the user has to dismiss is a claim on their attention, and a
 * plugin that could open a second one while the first is up could stack them
 * without bound. The second call is REFUSED rather than queued or allowed to
 * replace the first: queueing would make the refusal invisible and land the
 * dialogs later anyway, and replacing would let a plugin cancel a chooser the
 * user was already answering.
 */
const inFlight = new Set<string>();

/** Raised when a plugin asks for a second chooser while its first is open. */
export class FolderPickerBusyError extends Error {
  constructor(pluginId: string) {
    super(`[pick-folders] ${pluginId} already has a folder chooser open`);
    this.name = "FolderPickerBusyError";
  }
}

/**
 * Show the user a folder chooser on one plugin's behalf.
 *
 * @param pluginId  the caller, closed over by the host-api factory and never
 *                  passed in by the plugin — a plugin that could name the
 *                  caller could attribute its dialog to a different one.
 */
export async function pickFoldersForPlugin(
  pluginId: string,
  deps: PickFoldersDeps,
): Promise<PickFoldersResult> {
  if (inFlight.has(pluginId)) throw new FolderPickerBusyError(pluginId);
  inFlight.add(pluginId);
  try {
    // The ID, not `manifest.name`. The display name is plugin-authored free
    // text, so a plugin that wanted to be mistaken for the host — or for
    // another plugin — would only have to say so. The id is the host's install
    // key: validated at install, unique across installed plugins, and the same
    // string the permission trail records.
    const title = t("mainDialog.pluginPickFolderTitle", { plugin: pluginId });
    const parent = deps.parentWindow();
    // Parented where there is a window so the sheet belongs to it, unparented
    // otherwise — an unparented chooser still works, and refusing to ask
    // because no window happens to be up would turn a UX detail into a failure.
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title,
          properties: ["openDirectory", "multiSelections"],
        })
      : await dialog.showOpenDialog({
          title,
          properties: ["openDirectory", "multiSelections"],
        });
    // Electron reports a dismissal as `canceled`, and an empty selection is the
    // same answer wearing different clothes — both mean the user named nothing.
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, folders: [] };
    }
    return { canceled: false, folders: [...result.filePaths] };
  } finally {
    inFlight.delete(pluginId);
  }
}

/** Test seam: forget every in-flight chooser. Never called in production. */
export function resetFolderPickersForTest(): void {
  inFlight.clear();
}
