/**
 * The three `lvis://` uninstall refusals must reach the user as localized copy.
 *
 * Renderer tests run with the i18n runtime pinned to Korean (see
 * `src/i18n/testing/vitest-locale-ko.ts`), which is exactly the condition the
 * bug was reported under: `formatIpcError` had no entry for these codes and no
 * `message` half to fall back on, so the toast printed the producer's English
 * sentence verbatim next to Korean chrome.
 *
 * The codes come from the shared constants the producer broadcasts (see
 * `main/__tests__/lvis-deep-link-uninstall-result.test.ts` for the payload
 * side); the copy comes out of the REAL mounted hook over the REAL uninstall
 * subscription.
 */
import "../../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  ADMIN_PLUGIN_UNINSTALL_DENIED_CODE,
  PACKAGE_NOT_INSTALLED_CODE,
} from "../../../../../shared/plugin-install-result.js";
import { t } from "../../../../../i18n/runtime.js";
import type { PluginInstallResultPayload } from "../../../../../contract/app-contract.js";
import type { LvisApi } from "../../../types.js";
import { useStatusBarInstall } from "../use-status-bar-install.js";

type UninstallSubscription =
  | "onPluginUninstallResult"
  | "onAgentUninstallResult"
  | "onSkillUninstallResult";

/** Mount the real hook and return the uninstall toast the user would see. */
function uninstallToastFor(
  payload: PluginInstallResultPayload,
  subscription: UninstallSubscription,
): string {
  let deliver: ((p: PluginInstallResultPayload) => void) | null = null;
  const api = {
    [subscription]: (h: (p: PluginInstallResultPayload) => void) => {
      deliver = h;
      return () => { deliver = null; };
    },
  } as unknown as LvisApi;

  const pushed: Array<{ severity: string; message: string }> = [];
  renderHook(() =>
    useStatusBarInstall({
      api,
      pushToast: (input) => {
        pushed.push(input);
        return "";
      },
      upsertToast: () => "",
    }));

  expect(deliver, `hook did not subscribe to ${subscription}`).not.toBeNull();
  act(() => { deliver!(payload); });

  const last = pushed.at(-1);
  expect(last?.severity).toBe("error");
  return last?.message ?? "";
}

const SUBSCRIPTIONS: readonly [string, UninstallSubscription][] = [
  ["plugin", "onPluginUninstallResult"],
  ["agent", "onAgentUninstallResult"],
  ["skill", "onSkillUninstallResult"],
];

describe("uninstall refusal toast copy", () => {
  it.each(SUBSCRIPTIONS)(
    "renders localized not-installed copy for a %s, not the English predicate",
    (_family, subscription) => {
      const copy = uninstallToastFor(
        { slug: "sample", success: false, error: PACKAGE_NOT_INSTALLED_CODE },
        subscription,
      );

      expect(copy).toContain(t("formatIpcError.packageNotInstalled"));
      // The three shapes of the regression: the raw code, the English
      // predicate, and the half-localized welding of a Korean noun onto it.
      expect(copy).not.toContain(PACKAGE_NOT_INSTALLED_CODE);
      expect(copy).not.toContain("not installed");
      expect(copy).not.toContain(`${t("useStatusBarInstall.labelAgent")} not`);
    },
  );

  it("renders administrator-specific copy for the admin refusal", () => {
    const copy = uninstallToastFor(
      { slug: "sample", success: false, error: ADMIN_PLUGIN_UNINSTALL_DENIED_CODE },
      "onPluginUninstallResult",
    );

    expect(copy).toContain(t("formatIpcError.adminPluginUninstallDenied"));
    expect(copy).not.toContain(ADMIN_PLUGIN_UNINSTALL_DENIED_CODE);
    expect(copy).not.toContain("cannot be uninstalled by user");
    // The two refusals must not read alike: a user who cannot remove an
    // administrator's plugin needs different guidance from one whose package
    // simply is not installed.
    expect(copy).not.toContain(t("formatIpcError.packageNotInstalled"));
    // Nor may it be folded into the generic `managed` copy, which hedges
    // ("...or an error occurred while saving") and so reads as retryable.
    expect(copy).not.toBe(t("formatIpcError.managed"));
  });

  it("still surfaces an unmapped failure's own text, so mapping is not a swallow", () => {
    // Non-vacuity: proves the assertions above discriminate. An arbitrary
    // uninstall error with no stable code must still reach the user verbatim.
    const copy = uninstallToastFor(
      { slug: "sample", success: false, error: "disk full" },
      "onPluginUninstallResult",
    );

    expect(copy).toContain("disk full");
  });
});
