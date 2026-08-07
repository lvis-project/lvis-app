/**
 * `lvis:plugins:install-result` producer -> consumer contract.
 *
 * The payload used to be spelled out inline at the producer sites and
 * re-declared by three consumers, and the two halves disagreed in both
 * directions: the producer attached a `message` field that no consumer
 * declared — so the toast rendered the raw code `incompatible-app-version`
 * instead of the localized copy the producer's own comment promised — while
 * two consumers declared a `preparing` flag no producer ever set.
 *
 * Every payload here comes out of the REAL producer
 * (`buildInstallFailureResult`, sole constructor of the shape, called by the
 * install IPC handlers) and is delivered to the REAL consumer (the mounted
 * `useStatusBarInstall` hook) over the same subscription the preload bridge
 * feeds. No field of a payload is written by hand.
 */
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  buildInstallFailureResult,
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../../../../../plugins/public-contract.js";
import type { PluginInstallResultPayload } from "../../../../../contract/app-contract.js";
import type { LvisApi } from "../../../types.js";
import { useStatusBarInstall } from "../use-status-bar-install.js";

/**
 * Mount the real hook, push one real producer payload through the real
 * install-result subscription, and return the toast copy the user would see.
 */
function toastCopyFor(payload: PluginInstallResultPayload): string {
  let deliver: ((p: PluginInstallResultPayload) => void) | null = null;
  const api = {
    onPluginInstallResult: (h: (p: PluginInstallResultPayload) => void) => {
      deliver = h;
      return () => { deliver = null; };
    },
  } as unknown as LvisApi;

  const upserts: Array<{ severity: string; message: string }> = [];
  renderHook(() =>
    useStatusBarInstall({
      api,
      pushToast: () => "",
      upsertToast: (_id, input) => {
        upserts.push(input);
        return "";
      },
    }));

  expect(deliver, "hook did not subscribe to the install-result channel").not.toBeNull();
  act(() => { deliver!(payload); });

  const last = upserts.at(-1);
  expect(last?.severity).toBe("error");
  return last?.message ?? "";
}

const APP_VERSION_FAILURE = () =>
  buildInstallFailureResult(
    "sample",
    new IncompatibleAppVersionError("9.9.9", "1.0.0"),
    "addPlugin failed",
  );

describe("install-result payload", () => {
  it("carries the app-version code and its detail as separate fields", () => {
    const payload = APP_VERSION_FAILURE();

    expect(payload.slug).toBe("sample");
    expect(payload.success).toBe(false);
    expect(payload.error).toBe(INCOMPATIBLE_APP_VERSION_CODE);
    // The versions must survive as the detail half, not be collapsed away.
    expect(payload.message).toContain("9.9.9");
    expect(payload.message).toContain("1.0.0");
  });

  it("shows localized copy for an app-version failure, never the bare IPC code", () => {
    // The user-visible regression: the toast used to render `payload.error`
    // directly, so an incompatible plugin reported the literal string
    // "incompatible-app-version".
    expect(toastCopyFor(APP_VERSION_FAILURE()))
      .not.toContain(INCOMPATIBLE_APP_VERSION_CODE);
  });

  it("shows an unrecognised failure's own text", () => {
    const payload = buildInstallFailureResult(
      "sample",
      new Error("disk full"),
      "addPlugin failed",
    );

    expect(payload.error).toBe("disk full");
    expect(payload.message).toBeUndefined();
    expect(toastCopyFor(payload)).toContain("disk full");
  });

  it("falls back to the caller's message when the failure carries no text", () => {
    const payload = buildInstallFailureResult("sample", {}, "addPlugin failed");

    expect(payload.error).toBe("addPlugin failed");
    expect(toastCopyFor(payload)).toContain("addPlugin failed");
  });

  it("never emits the preparing flag two consumers used to declare", () => {
    for (const failure of [
      new IncompatibleAppVersionError("9.9.9", "1.0.0"),
      new Error("disk full"),
      {},
    ]) {
      const payload = buildInstallFailureResult("sample", failure, "addPlugin failed");
      expect(Object.keys(payload)).not.toContain("preparing");
    }
  });

  it("subscribes through the same bridge method the preload exposes", () => {
    const onPluginInstallResult = vi.fn(() => () => undefined);
    renderHook(() =>
      useStatusBarInstall({
        api: { onPluginInstallResult } as unknown as LvisApi,
        pushToast: () => "",
        upsertToast: () => "",
      }));

    expect(onPluginInstallResult).toHaveBeenCalledOnce();
  });
});
