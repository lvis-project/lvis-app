/**
 * Unit tests for the Plugin Doctor failure taxonomy + cause classifier.
 *
 * The classifier is the SOT that lets the Doctor tell REINSTALL-FIXABLE
 * failures (stale/pre-v6/schema-invalid on-disk manifest, missing/corrupt
 * files, generic load errors) apart from NOT-locally-fixable ones (catalog↔
 * grant mismatch, app-version incompatibility) so it auto-repairs the former
 * and falls back to a diagnosis for the latter.
 */
import { describe, it, expect } from "vitest";
import {
  PLUGIN_INSTALL_FAILURE_KINDS,
  isPluginInstallFailureKind,
  isReinstallFixableFailureKind,
} from "../plugin-install-failure.js";

describe("isPluginInstallFailureKind", () => {
  it("accepts every declared kind", () => {
    for (const kind of PLUGIN_INSTALL_FAILURE_KINDS) {
      expect(isPluginInstallFailureKind(kind)).toBe(true);
    }
  });

  it("rejects unknown values and non-strings", () => {
    expect(isPluginInstallFailureKind("not-a-kind")).toBe(false);
    expect(isPluginInstallFailureKind(undefined)).toBe(false);
    expect(isPluginInstallFailureKind(null)).toBe(false);
    expect(isPluginInstallFailureKind(42)).toBe(false);
  });
});

describe("isReinstallFixableFailureKind", () => {
  it("classifies a pre-v6/schema manifest failure as reinstall-fixable", () => {
    // The motivating #885 Phase R case: an installed plugin whose on-disk
    // manifest is a stale/pre-v6 shape now fails schema validation at load.
    // The runtime maps that to `manifest-validation-error`; reinstalling the
    // latest marketplace version ships a valid manifest.
    expect(isReinstallFixableFailureKind("manifest-validation-error")).toBe(true);
  });

  it("treats an unclassified load failure (undefined) as reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind(undefined)).toBe(true);
  });

  it("classifies catalog↔grant mismatch as NOT reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind("catalog-grant-mismatch")).toBe(false);
  });

  it("classifies app-version incompatibility as NOT reinstall-fixable", () => {
    expect(isReinstallFixableFailureKind("incompatible-app-version")).toBe(false);
  });

  it("partitions the full taxonomy without leaving a kind unclassified", () => {
    const fixable = PLUGIN_INSTALL_FAILURE_KINDS.filter((kind) =>
      isReinstallFixableFailureKind(kind),
    );
    const notFixable = PLUGIN_INSTALL_FAILURE_KINDS.filter(
      (kind) => !isReinstallFixableFailureKind(kind),
    );
    expect(fixable).toEqual(["manifest-validation-error"]);
    expect(notFixable).toEqual(["catalog-grant-mismatch", "incompatible-app-version"]);
  });
});
