/**
 * The host's folder picker, measured against a stubbed `dialog`.
 *
 * WHAT THESE CASES ARE FOR. The picker's whole safety argument is that it hands
 * back an ANSWER rather than a reach: the paths come from the OS, the title
 * names the caller, and a second concurrent chooser is refused. Each of those
 * is a claim a future edit could break silently, so each is pinned here.
 *
 * `dialog` is stubbed rather than driven, because a native chooser has no
 * scriptable "the user picked this" — the thing worth pinning is what the host
 * ASKS Electron for and what it does with the reply, both of which are visible
 * at that seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const showOpenDialog = vi.fn();
vi.mock("electron", () => ({ dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) } }));

import {
  pickFoldersForPlugin,
  resetFolderPickersForTest,
  FolderPickerBusyError,
} from "../pick-folders.js";
import type { BrowserWindow } from "electron";

/** A stand-in for a real window; only its identity is ever compared. */
const FAKE_WINDOW = { id: 7 } as unknown as BrowserWindow;

const withWindow = { parentWindow: () => FAKE_WINDOW };
const withoutWindow = { parentWindow: () => null };

beforeEach(() => {
  showOpenDialog.mockReset();
  resetFolderPickersForTest();
});

describe("what the host asks the OS for", () => {
  it("asks for directories, allows more than one, and names the caller in the title", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/Users/probe/Docs"] });

    await pickFoldersForPlugin("local-indexer", withWindow);

    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    const [parent, options] = showOpenDialog.mock.calls[0] as [BrowserWindow, Record<string, unknown>];
    expect(parent).toBe(FAKE_WINDOW);
    expect(options.properties).toEqual(["openDirectory", "multiSelections"]);
    // The ID, never `manifest.name`: a plugin-authored display name is free
    // text, so attribution built on it could be made to read as the host's own.
    expect(String(options.title)).toContain("local-indexer");
  });

  it("still asks when no window is up, rather than failing because none was", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await pickFoldersForPlugin("local-indexer", withoutWindow);

    expect(result.canceled).toBe(true);
    // ONE argument — the unparented overload. Called with `(null, options)`
    // Electron would treat the null as the options bag and throw.
    expect(showOpenDialog.mock.calls[0]).toHaveLength(1);
  });
});

describe("what the plugin gets back", () => {
  it("returns the paths the OS reported, in order", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/probe/A", "/Users/probe/B"],
    });

    const result = await pickFoldersForPlugin("local-indexer", withWindow);

    expect(result).toEqual({ canceled: false, folders: ["/Users/probe/A", "/Users/probe/B"] });
  });

  it("reports a dismissal as an answer, not an error", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(pickFoldersForPlugin("local-indexer", withWindow)).resolves.toEqual({
      canceled: true,
      folders: [],
    });
  });

  it("reads an empty selection as the same answer as a dismissal", async () => {
    // Electron can report `canceled: false` with nothing selected. The two
    // spellings mean the same thing — the user named no folder — and a caller
    // that had to tell them apart would be branching on a distinction with no
    // consequence.
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });

    await expect(pickFoldersForPlugin("local-indexer", withWindow)).resolves.toEqual({
      canceled: true,
      folders: [],
    });
  });
});

describe("one chooser per plugin", () => {
  it("refuses a second chooser while the first is still up", async () => {
    let release: (value: { canceled: boolean; filePaths: string[] }) => void = () => {};
    showOpenDialog.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = pickFoldersForPlugin("local-indexer", withWindow);
    await expect(pickFoldersForPlugin("local-indexer", withWindow)).rejects.toBeInstanceOf(
      FolderPickerBusyError,
    );
    // REFUSED, not queued: the second call must not have reached Electron, or
    // the user would get the extra modal anyway, just later.
    expect(showOpenDialog).toHaveBeenCalledTimes(1);

    release({ canceled: true, filePaths: [] });
    await first;
  });

  it("lets a DIFFERENT plugin ask while the first one's chooser is up", async () => {
    // The bound is per-plugin because it exists to stop ONE plugin stacking
    // modals. A shared bound would let any plugin with a chooser open suppress
    // every other plugin's — a cross-plugin channel, and a denial of service.
    let release: (value: { canceled: boolean; filePaths: string[] }) => void = () => {};
    showOpenDialog.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/probe/C"] });

    const first = pickFoldersForPlugin("local-indexer", withWindow);
    const second = await pickFoldersForPlugin("meeting", withWindow);

    expect(second).toEqual({ canceled: false, folders: ["/Users/probe/C"] });
    release({ canceled: true, filePaths: [] });
    await first;
  });

  it("frees the slot when the chooser throws, so one failure is not permanent", async () => {
    showOpenDialog.mockRejectedValueOnce(new Error("dialog exploded"));
    await expect(pickFoldersForPlugin("local-indexer", withWindow)).rejects.toThrow("dialog exploded");

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/probe/D"] });
    await expect(pickFoldersForPlugin("local-indexer", withWindow)).resolves.toEqual({
      canceled: false,
      folders: ["/Users/probe/D"],
    });
  });
});
