/**
 * The corporate CA settings/environment precedence, and the name validator the
 * three layers share.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORP_CA_COMMON_NAME,
  MAX_CORP_CA_COMMON_NAME_LENGTH,
  normalizeCorpCaCommonName,
} from "../corp-ca-common-name.js";
import { resolveCorpCaConfig } from "../corp-ca-config.js";

describe("normalizeCorpCaCommonName", () => {
  it("accepts a certificate name and trims it", () => {
    expect(normalizeCorpCaCommonName("  Acme Root CA  ")).toBe("Acme Root CA");
    // Real corporate CNs carry punctuation; none of it is rejected, because the
    // value never reaches a shell.
    expect(normalizeCorpCaCommonName("Acme Corp. Root CA (G2), Ltd.")).toBe(
      "Acme Corp. Root CA (G2), Ltd.",
    );
  });

  it("rejects what is not a name", () => {
    expect(normalizeCorpCaCommonName("")).toBeNull();
    expect(normalizeCorpCaCommonName("   ")).toBeNull();
    expect(normalizeCorpCaCommonName(undefined)).toBeNull();
    expect(normalizeCorpCaCommonName(42)).toBeNull();
    expect(normalizeCorpCaCommonName("x".repeat(MAX_CORP_CA_COMMON_NAME_LENGTH + 1))).toBeNull();
  });

  it("rejects control characters, so one log line cannot become two", () => {
    expect(normalizeCorpCaCommonName("Acme\nRoot")).toBeNull();
    expect(normalizeCorpCaCommonName("Acme\u0000Root")).toBeNull();
    expect(normalizeCorpCaCommonName("Acme\u007fRoot")).toBeNull();
  });
});

describe("resolveCorpCaConfig", () => {
  it("uses the defaults when nothing is set", () => {
    expect(resolveCorpCaConfig({}, {})).toEqual({
      enabled: true,
      commonName: DEFAULT_CORP_CA_COMMON_NAME,
      debugLog: false,
    });
  });

  it("uses the saved settings when the environment is silent", () => {
    expect(resolveCorpCaConfig(
      { enabled: false, commonName: "Acme Root CA", debugLog: true },
      {},
    )).toEqual({ enabled: false, commonName: "Acme Root CA", debugLog: true });
  });

  it("lets the environment override each field", () => {
    expect(resolveCorpCaConfig(
      { enabled: true, commonName: "Acme Root CA", debugLog: false },
      {
        LVIS_SKIP_CORP_CA: "1",
        LVIS_CORP_CA_CN: "Other Root CA",
        LVIS_CORP_CA_DEBUG: "1",
      },
    )).toEqual({ enabled: false, commonName: "Other Root CA", debugLog: true });
  });

  it("ignores environment values that are not the trigger", () => {
    // `LVIS_SKIP_CORP_CA=0` is not "skip"; the saved value still decides.
    expect(resolveCorpCaConfig({ enabled: true }, { LVIS_SKIP_CORP_CA: "0" }).enabled).toBe(true);
    expect(resolveCorpCaConfig({ debugLog: false }, { LVIS_CORP_CA_DEBUG: "yes" }).debugLog)
      .toBe(false);
  });

  it("falls back past an unusable name rather than searching for it", () => {
    // A hand-edited profile, or an environment variable set to whitespace.
    expect(resolveCorpCaConfig({ commonName: "  " }, {}).commonName)
      .toBe(DEFAULT_CORP_CA_COMMON_NAME);
    expect(resolveCorpCaConfig({ commonName: "Acme Root CA" }, { LVIS_CORP_CA_CN: "   " })
      .commonName).toBe("Acme Root CA");
  });
});
