/**
 * `web_fetch` grades the REQUEST, not the destination.
 *
 * Grading the destination meant every public fetch rated HIGH and raised a
 * dialog, so reading a documentation page cost an approval. A dialog answered
 * that often is answered with "always", which is auto-allow with extra steps —
 * the same hole the destination rule existed to close, reached by a route the
 * user opened themselves.
 *
 * What actually distinguishes an exfiltrating fetch is the shape of the URL:
 * data leaves in the tail. So a screened-clean public fetch runs unprompted and
 * a request carrying a credential, an oversized tail, an opaque blob or
 * userinfo still escalates. Everything the `network` category buys — withheld
 * from unattended lanes, not covered by an away-authority read grant, no
 * standing allow rule — is unchanged, and this file asserts the parts of that
 * which are decided here.
 *
 * Lives beside `network-target.test.ts` rather than inside it: that file pins
 * the one extractor two consumers share, this one pins the verdict lane built
 * on top of it.
 */
import { describe, it, expect } from "vitest";
import { RuleBasedRiskClassifier } from "../risk-classifier.js";
import { makeRiskClassifierContext } from "../../__tests__/test-helpers.js";

const rb = new RuleBasedRiskClassifier();

/** Grade a `web_fetch` invocation the way the pipeline does. */
function verdictFor(input: Record<string, unknown>) {
  return rb.classify(makeRiskClassifierContext({
    toolName: "web_fetch",
    source: "builtin",
    category: "network",
    pathFields: [],
    finalInput: input,
  }));
}

/** 40 hex characters — the shape a content-addressed URL also has. */
const OPAQUE_BLOB = "9f2b1c8a7d3e4f5061728394a5b6c7d8e9f0a1b2";
/** base64url: its own alphabet includes `-` and `_`, so it carries separators. */
const BASE64URL_BLOB = "aGVsbG8td29ybGQ_dGhpcyBpcyBzZWNyZXQtZGF0YQ";
/** A credential the shared scrubber recognizes. */
const CREDENTIAL = "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz";

describe("web_fetch — public requests run unprompted", () => {
  it("rates a plain documentation URL low", () => {
    const verdict = verdictFor({ url: "https://docs.example.org/guide/install" });
    expect(verdict.level).toBe("low");
    expect(verdict.reason).toContain("screened");
  });

  it("rates an ordinary query low — a search term is not a payload", () => {
    expect(verdictFor({ url: "https://example.org/search?q=hello+world" }).level).toBe("low");
  });

  it("keeps a trusted host low", () => {
    expect(verdictFor({ url: "https://api.github.com/repos/x/y" }).level).toBe("low");
  });

  // The whole point of the change. These are the URLs a model reads
  // documentation from, and every one of them scores 3.5-4.0 bits per
  // character — the same range as a commit hash — so an entropy threshold
  // cannot tell them apart from a payload. Word separators can.
  it.each([
    ["a long article slug", "https://example.org/how-to-configure-your-database-connection"],
    ["a versioned guide slug", "https://example.org/v2-migration-guide-for-the-parser-api"],
    ["a deep doc anchor", "https://example.org/docs/getting-started-with-authentication"],
    ["a scoped package path", "https://example.org/@typescript-eslint/parser-v8-migration"],
    ["an identifier in the path", "https://example.org/issues/550e8400-e29b-41d4-a716-446655440000"],
    ["several slug segments", "https://example.org/blog/2026/setting-up-continuous-integration/part-two"],
  ])("does not prompt for %s", (_label, url) => {
    expect(verdictFor({ url }).level).toBe("low");
  });
});

describe("web_fetch — the screen escalates a request that carries data", () => {
  it.each([
    ["a credential in the query", `https://example.org/collect?token=${CREDENTIAL}`, "credential-in-url"],
    ["userinfo in the authority", "https://user:pw@example.org/", "url-userinfo"],
    ["an opaque blob in a query value", `https://example.org/p?d=${OPAQUE_BLOB}`, "high-entropy-blob"],
    ["an opaque blob in a path segment", `https://example.org/${OPAQUE_BLOB}`, "high-entropy-blob"],
    ["an opaque blob in the fragment", `https://example.org/p#${OPAQUE_BLOB}`, "high-entropy-blob"],
    ["base64url in a query value", `https://example.org/p?d=${BASE64URL_BLOB}`, "high-entropy-blob"],
    ["a payload smuggled as a query NAME", `https://example.org/p?${OPAQUE_BLOB}=1`, "high-entropy-blob"],
    ["a payload in a hostname label", `https://${OPAQUE_BLOB}.example.org/p`, "high-entropy-blob"],
  ])("escalates %s", (_label, url, signal) => {
    const verdict = verdictFor({ url });
    expect(verdict.level).toBe("high");
    expect(verdict.reason).toContain("possible exfiltration");
    expect(verdict.reason).toContain(signal);
  });

  it("escalates an oversized tail whatever it is made of", () => {
    // Low-entropy on purpose: length alone is the signal, because prose is
    // exactly what a URL is not a way to carry.
    const verdict = verdictFor({ url: `https://example.org/p?note=${"aba".repeat(200)}` });
    expect(verdict.level).toBe("high");
    expect(verdict.reason).toContain("oversized-url-tail");
  });

  it("names the most specific signal when a request carries several", () => {
    const verdict = verdictFor({ url: `https://user:pw@example.org/p?token=${CREDENTIAL}` });
    expect(verdict.reason).toContain("url-userinfo");
  });
});

describe("web_fetch — destinations the screen does not clear", () => {
  it("rates a routable address literal medium: nobody named that destination", () => {
    const verdict = verdictFor({ url: "http://8.8.8.8/data" });
    expect(verdict.level).toBe("medium");
    expect(verdict.reason).toContain("raw ip");
  });

  it("does not clear a reserved literal either — it is not a routable public host", () => {
    // TEST-NET-3 (RFC 5737) is not globally routable, so it is not the public
    // destination this lane clears; it keeps the verdict it had before.
    expect(verdictFor({ url: "http://203.0.113.7/data" }).level).not.toBe("low");
  });

  it("leaves localhost on its existing medium verdict", () => {
    const verdict = verdictFor({ url: "http://localhost:3000/x" });
    expect(verdict.level).toBe("medium");
    expect(verdict.reason).toContain("localhost");
  });

  it.each([
    ["a private address", "http://10.0.0.5/admin"],
    ["the cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
  ])("does not clear %s", (_label, url) => {
    expect(verdictFor({ url }).level).not.toBe("low");
  });

  it("does not clear a private-network opt-in, whatever the URL looks like", () => {
    expect(verdictFor({
      url: "https://docs.example.org/guide",
      allowPrivateNetwork: true,
    }).level).not.toBe("low");
  });

  it("does not clear a request with no parseable URL", () => {
    expect(verdictFor({ url: "not a url" }).level).not.toBe("low");
    expect(verdictFor({ host: "example.org" }).level).not.toBe("low");
  });
});

describe("web_fetch — the lane is the tool's alone", () => {
  it("leaves another builtin's public fetch on the untrusted-host verdict", () => {
    const verdict = rb.classify(makeRiskClassifierContext({
      toolName: "some_other_tool",
      source: "builtin",
      category: "network",
      pathFields: [],
      finalInput: { url: "https://docs.example.org/guide" },
    }));
    expect(verdict.level).toBe("high");
    expect(verdict.reason).toContain("untrusted host");
  });

  it("leaves a plugin tool that borrowed the name on the untrusted-host verdict", () => {
    const verdict = rb.classify(makeRiskClassifierContext({
      toolName: "web_fetch",
      source: "plugin",
      category: "network",
      pathFields: [],
      finalInput: { url: "https://docs.example.org/guide" },
    }));
    expect(verdict.level).toBe("high");
  });
});
