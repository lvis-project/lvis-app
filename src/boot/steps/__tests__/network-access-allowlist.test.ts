import { describe, it, expect } from "vitest";
import {
  normalizeAllowedHosts,
  urlHostMatchesAllowList,
} from "../../../main/host-allow-list.js";

/**
 * Tier A — the deny-by-default egress contract enforced inside
 * `createHostApi.hostFetch`. hostFetch normalizes
 * `manifest.networkAccess.allowedDomains` and matches the target host with the
 * same two helpers exercised here, so this pins the policy semantics the
 * runtime relies on without standing up the full plugin runtime.
 */
function egressAllowed(allowedDomains: string[], targetUrl: string): boolean {
  const normalized = normalizeAllowedHosts(allowedDomains);
  return urlHostMatchesAllowList(new URL(targetUrl).hostname, normalized);
}

describe("networkAccess deny-by-default egress allow-list", () => {
  it("denies everything when no domains are declared", () => {
    expect(egressAllowed([], "https://api.openai.com/v1/audio/transcriptions")).toBe(false);
    expect(egressAllowed([], "https://aif-x.openai.azure.com/openai/x")).toBe(false);
  });

  it("allows a declared Azure OpenAI resource via dot-boundary suffix match", () => {
    const allow = ["openai.azure.com", "api.openai.com"];
    expect(
      egressAllowed(allow, "https://aif-swc-axpg-hq-hckt19.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions"),
    ).toBe(true);
    expect(egressAllowed(allow, "https://api.openai.com/v1/audio/transcriptions")).toBe(true);
  });

  it("denies hosts not on the list (incl. suffix-spoof and unrelated)", () => {
    const allow = ["openai.azure.com"];
    expect(egressAllowed(allow, "https://evil.com/x")).toBe(false);
    // suffix-spoof: allow-list host as a left label of an attacker domain
    expect(egressAllowed(allow, "https://openai.azure.com.attacker.com/x")).toBe(false);
    // declared azure does NOT implicitly allow public OpenAI
    expect(egressAllowed(allow, "https://api.openai.com/v1/audio/transcriptions")).toBe(false);
  });

  it("rejects a malformed allow-list (wildcard) at normalization", () => {
    expect(() => normalizeAllowedHosts(["*.openai.azure.com"])).toThrow();
    expect(() => normalizeAllowedHosts(["*"])).toThrow();
    // bare public-suffix-style top level cannot be declared
    expect(() => normalizeAllowedHosts(["com"])).toThrow();
  });

  it("meeting's declared STT domains cover Azure + OpenAI transcription hosts", () => {
    const meetingDomains = [
      "openai.azure.com",
      "cognitiveservices.azure.com",
      "services.ai.azure.com",
      "api.openai.com",
    ];
    expect(egressAllowed(meetingDomains, "https://aif-x.openai.azure.com/openai/x")).toBe(true);
    expect(egressAllowed(meetingDomains, "https://aif-x.cognitiveservices.azure.com/x")).toBe(true);
    expect(egressAllowed(meetingDomains, "https://api.openai.com/v1/audio/transcriptions")).toBe(true);
    expect(egressAllowed(meetingDomains, "https://graph.microsoft.com/v1.0/me")).toBe(false);
  });
});
