/**
 * One extractor answers "which endpoint is this call aimed at" for BOTH the
 * category decision (`inspectHostRisk`) and the network verdict
 * (`RuleBasedRiskClassifier`).
 *
 * They used to be two implementations. The category side scanned every
 * top-level string for a URL (default-strict: a URL hidden under an arbitrary
 * key still escalates); the verdict side only looked at `url` / `endpoint` /
 * `host` / `uri`. So `{ target: "https://api.openai.com/v1/chat" }` escalated to
 * category `network` and then rated HIGH "network untrusted host" — the
 * trusted-host allowance could not be reached from any key outside the named
 * four. Consolidating makes it reachable, which LOOSENS those verdicts.
 */
import { describe, it, expect } from "vitest";
import { RuleBasedRiskClassifier } from "../risk-classifier.js";
import { inspectHostRisk } from "../host-risk-inspector.js";
import {
  extractNetworkTarget,
  hasNetworkTarget,
  NETWORK_TARGET_FIELDS,
} from "../network-target.js";
import { makeRiskClassifierContext } from "../../__tests__/test-helpers.js";

const rb = new RuleBasedRiskClassifier();

/** Drive both consumers from the same arguments, as the pipeline does. */
function categoryAndVerdict(input: Record<string, unknown>) {
  const category = inspectHostRisk({
    source: "plugin",
    finalInput: input,
  });
  const verdict = rb.classify(makeRiskClassifierContext({
    category,
    pathFields: [],
    finalInput: input,
  }));
  return { category, level: verdict.level, reason: verdict.reason };
}

describe("the two consumers agree because they share one extractor", () => {
  const SHAPES: Array<Record<string, unknown>> = [
    { url: "https://api.openai.com/v1/chat" },
    { target: "https://api.openai.com/v1/chat" },
    { destination: "https://lvisai.xyz/x" },
    { host: "api.openai.com" },
    { endpoint: "api.openai.com" },
    { uri: "https://evil.example/x" },
    { host: "junk not a host!!" },
    { url: "not-a-url" },
    { url: "https:///x" },
    { url: "file:///etc/passwd" },
    { url: "ftp://example.com/x" },
    { note: "no endpoint anywhere" },
  ];

  for (const input of SHAPES) {
    it(`${JSON.stringify(input)}: category "network" iff a target was extracted`, () => {
      const target = extractNetworkTarget(input);
      expect(hasNetworkTarget(input)).toBe(target !== null);
      // `inspectHostRisk` only reaches the network branch for non-shell calls,
      // which every shape here is.
      expect(categoryAndVerdict(input).category === "network").toBe(target !== null);
    });
  }
});

describe("the trusted-host rule is now reachable from any key — the approved LOOSENING", () => {
  const TRUSTED_UNDER_ARBITRARY_KEY: Array<{ input: Record<string, unknown>; host: string }> = [
    { input: { target: "https://api.openai.com/v1/chat" }, host: "api.openai.com" },
    { input: { destination: "https://lvisai.xyz/x" }, host: "lvisai.xyz" },
    { input: { webhook: "https://api.anthropic.com/v1/m" }, host: "api.anthropic.com" },
    { input: { callbackUrl: "https://generativelanguage.googleapis.com/v1/x" }, host: "generativelanguage.googleapis.com" },
  ];

  for (const { input, host } of TRUSTED_UNDER_ARBITRARY_KEY) {
    it(`${JSON.stringify(input)} → LOW (was HIGH "network untrusted host")`, () => {
      // The key is genuinely outside the named set — otherwise this row would
      // have been reachable before and would prove nothing.
      const key = Object.keys(input)[0];
      expect(NETWORK_TARGET_FIELDS).not.toContain(key);
      expect(categoryAndVerdict(input)).toEqual({
        category: "network",
        level: "low",
        reason: `network trusted host (${host})`,
      });
    });
  }

  it("a bare trusted hostname in `endpoint` now reaches the network domain at all", () => {
    // Before: the category side required a parseable URL on `endpoint`, so a
    // bare hostname there was not a network target and the call fell through to
    // the default-strict `write` domain → HIGH "write path not declared".
    expect(categoryAndVerdict({ endpoint: "api.openai.com" })).toEqual({
      category: "network",
      level: "low",
      reason: "network trusted host (api.openai.com)",
    });
  });

  it("an UNtrusted host under an arbitrary key stays HIGH — the loosening is not blanket", () => {
    expect(categoryAndVerdict({ target: "https://evil.example/x" })).toEqual({
      category: "network",
      level: "high",
      reason: "network untrusted host",
    });
  });

  it("localhost under an arbitrary key rates MEDIUM, not LOW", () => {
    expect(categoryAndVerdict({ target: "http://127.0.0.1:8080/x" })).toEqual({
      category: "network",
      level: "medium",
      reason: "network localhost (127.0.0.1)",
    });
  });

  it("a Graph write under an arbitrary key still rates MEDIUM", () => {
    expect(categoryAndVerdict({
      target: "https://graph.microsoft.com/v1.0/me/sendMail",
      payload: "hello",
    })).toEqual({
      category: "network",
      level: "medium",
      reason: "network graph data operation",
    });
  });
});

describe("extraction order and scheme handling are preserved", () => {
  it("a named field outranks an incidental URL under another key", () => {
    expect(extractNetworkTarget({
      target: "https://evil.example/x",
      url: "https://api.openai.com/v1/chat",
    })).toEqual({ host: "api.openai.com", path: "/v1/chat" });
  });

  it("named fields are tried in declaration order", () => {
    expect(NETWORK_TARGET_FIELDS).toEqual(["url", "endpoint", "host", "uri"]);
    expect(extractNetworkTarget({
      uri: "https://api.anthropic.com/x",
      endpoint: "https://api.openai.com/y",
    })).toEqual({ host: "api.openai.com", path: "/y" });
  });

  it("a non-network scheme is not a target, under a named key or any other", () => {
    expect(extractNetworkTarget({ url: "file:///etc/passwd" })).toBeNull();
    expect(extractNetworkTarget({ payload: "ftp://example.com/x" })).toBeNull();
    // …so such a call stays in the filesystem/default-strict domain.
    expect(categoryAndVerdict({ url: "file:///etc/passwd" }).category).toBe("write");
  });

  it("ws:// counts, so a websocket endpoint is still a network target", () => {
    expect(extractNetworkTarget({ target: "wss://api.openai.com/stream" }))
      .toEqual({ host: "api.openai.com", path: "/stream" });
  });

  it("an empty-authority URL is normalized by WHATWG, not treated as hostless", () => {
    // An empty-authority https URL parses with the first path segment promoted
    // to the authority, so there is no reachable "hostless network URL" shape.
    // Pinned because it is the input that looks like it should produce one.
    expect(extractNetworkTarget({ url: "https:///x" })).toEqual({ host: "x", path: "/" });
    expect(categoryAndVerdict({ url: "https:///x" })).toEqual({
      category: "network",
      level: "high",
      reason: "network untrusted host",
    });
  });

  it("a junk `host` field is taken as a hostname so the call cannot leave the network domain", () => {
    expect(extractNetworkTarget({ host: "junk not a host!!" }))
      .toEqual({ host: "junk not a host!!", path: "" });
    expect(categoryAndVerdict({ host: "junk not a host!!" })).toEqual({
      category: "network",
      level: "high",
      reason: "network untrusted host",
    });
  });

  it("a non-URL value in a named field is a bare-host candidate — STRICTER category movement", () => {
    // Before: the category side saw no network target and fell through to
    // `write` → HIGH "write path not declared". Now the declared `url` field is
    // honoured as a (bogus) hostname → HIGH "network untrusted host".
    expect(categoryAndVerdict({ url: "not-a-url" })).toEqual({
      category: "network",
      level: "high",
      reason: "network untrusted host",
    });
  });
});
