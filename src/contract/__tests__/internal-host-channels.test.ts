/**
 * #1409 C12 — out-of-tree host channel classification.
 *
 * The two channel families registered OUTSIDE `src/ipc/` (window layout in
 * window-manager.ts and updates in auto-updater.ts) are classified INTERNAL by
 * {@link INTERNAL_HOST_CHANNELS}.
 * This closes the previously-unclassified out-of-tree hole. Asserts:
 *   1. none of the internal families appear in PUBLIC_CHANNELS (fail-closed),
 *   2. isPublicChannel() returns false for every one of them,
 *   3. the recorded strings are BYTE-IDENTICAL to the literals at the sites
 *      (guards against silent drift from the C17 sweep).
 */
import { describe, it, expect } from "vitest";
import {
  INTERNAL_HOST_CHANNELS,
  PUBLIC_CHANNELS,
  isPublicChannel,
} from "../app-contract.js";

const allInternal = [
  ...INTERNAL_HOST_CHANNELS.windowManager,
  ...INTERNAL_HOST_CHANNELS.autoUpdater,
];

describe("#1409 out-of-tree host channels are classified INTERNAL", () => {
  it("no internal host channel leaks into PUBLIC_CHANNELS", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    for (const channel of allInternal) {
      expect(publicSet.has(channel), `internal channel leaked public: ${channel}`).toBe(false);
    }
  });

  it("isPublicChannel is fail-closed for every internal host channel", () => {
    for (const channel of allInternal) {
      expect(isPublicChannel(channel), channel).toBe(false);
    }
  });

  it("records the exact (byte-identical) out-of-tree literals", () => {
    expect(INTERNAL_HOST_CHANNELS.windowManager).toEqual([
      "lvis:window:resize-for-mode",
      "lvis:window:resize-for-side-panel",
    ]);
    expect(INTERNAL_HOST_CHANNELS.autoUpdater).toEqual([
      "lvis:update:state",
      "lvis:update:get-state",
      "lvis:update:download-now",
      "lvis:update:install-now",
      "lvis:update:skip-version",
    ]);
  });
});
