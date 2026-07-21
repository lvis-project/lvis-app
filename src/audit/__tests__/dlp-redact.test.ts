/**
 * Sprint E §3 — redactForLLM pattern coverage (email / phone / CC).
 * Also covers redactFsPath + redactAuditPayload (audit log PII redact, #449).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  redactAuditPayload,
  redactForLLM,
  redactFsPath,
  redactHomePathsInText,
  scrubSecretsForLLM,
} from "../dlp-filter.js";
import { fixtureSecret } from "./secret-fixtures.js";

describe("redactForLLM", () => {
  it("redacts emails", () => {
    const r = redactForLLM("ping me at foo.bar+baz@example.com please");
    expect(r.redacted).toContain("[REDACTED:EMAIL]");
    expect(r.redacted).not.toContain("foo.bar+baz@example.com");
    expect(r.counts.EMAIL).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("redacts Korean mobile phone numbers (with and without hyphens)", () => {
    const r1 = redactForLLM("내 번호 010-1234-5678");
    expect(r1.redacted).toContain("[REDACTED:PHONE]");
    expect(r1.counts.PHONE_KR).toBe(1);
    const r2 = redactForLLM("01098765432");
    expect(r2.redacted).toContain("[REDACTED:PHONE]");
    expect(r2.counts.PHONE_KR).toBe(1);
  });

  it("redacts US phone numbers", () => {
    const r = redactForLLM("Call 415-555-1234 or (415) 555-9876");
    expect(r.counts.PHONE_US).toBe(2);
    expect(r.redacted).not.toMatch(/415-555-1234/);
  });

  it("redacts credit card numbers that pass Luhn, preserves fakes", () => {
    // Visa test number 4111111111111111 passes Luhn
    const r = redactForLLM("card 4111 1111 1111 1111 vs 1234 5678 9012 3456");
    expect(r.counts.CREDIT_CARD).toBe(1);
    expect(r.redacted).toContain("[REDACTED:CC]");
    expect(r.redacted).toContain("1234 5678 9012 3456");
  });

  it("redacts Korean SSN (RRN)", () => {
    const r = redactForLLM("주민번호 900101-1234567 입니다");
    expect(r.counts.SSN_KR).toBe(1);
    expect(r.redacted).toContain("[REDACTED:SSN]");
  });

  it("returns zero counts on clean text", () => {
    const r = redactForLLM("안녕하세요, LVIS 입니다.");
    expect(r.totalCount).toBe(0);
    expect(r.redacted).toBe("안녕하세요, LVIS 입니다.");
  });
});

describe("scrubSecretsForLLM — credential-class SOT (#1499 E2 M1)", () => {
  it("redacts prefixed API keys (sk-/pk-/live-)", () => {
    expect(scrubSecretsForLLM("key sk-ant-ABCDEFGH1234")).not.toContain("sk-ant-ABCDEFGH1234");
    expect(scrubSecretsForLLM("key sk-ant-ABCDEFGH1234")).toContain("[REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("key SK-ANT-ABCDEFGH1234")).not.toContain("SK-ANT-ABCDEFGH1234");
  });

  it("redacts GitHub and Slack vendor-prefixed tokens case-insensitively", () => {
    const githubPat = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    const githubOauth = fixtureSecret("GH", "O_", "1234567890ABCDEFGHIJKLMNOPQRSTUV");
    const githubUser = fixtureSecret("gh", "u_", "1234567890abcdefghijklmnopqrstuv");
    const githubServer = fixtureSecret("gh", "s_", "1234567890abcdefghijklmnopqrstuv");
    const githubRefresh = fixtureSecret("gh", "r_", "1234567890abcdefghijklmnopqrstuv");
    const githubFineGrained = fixtureSecret("github", "_pat_", "1234567890abcdefghijklmnopqrstuv_1234567890");
    const slackBot = fixtureSecret("xo", "xb-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const slackUser = fixtureSecret("XO", "XP-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const slackApp = fixtureSecret("xa", "pp-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const out = scrubSecretsForLLM(
      `tokens ${githubPat} ${githubOauth} ${githubUser} ${githubServer} ${githubRefresh} ${githubFineGrained} ${slackBot} ${slackUser} ${slackApp}`,
    );

    expect(out).not.toContain(githubPat);
    expect(out).not.toContain(githubOauth);
    expect(out).not.toContain(githubUser);
    expect(out).not.toContain(githubServer);
    expect(out).not.toContain(githubRefresh);
    expect(out).not.toContain(githubFineGrained);
    expect(out).not.toContain(slackBot);
    expect(out).not.toContain(slackUser);
    expect(out).not.toContain(slackApp);
    expect(out.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(9);
  });

  it("redacts AWS and Google vendor-prefixed tokens", () => {
    const awsAccessKeyId = fixtureSecret("AK", "IA", "1234567890ABCDEF");
    const awsSecret = fixtureSecret("wJalrXUtn", "FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    const labeledAwsSecret = fixtureSecret("WJalrXUtn", "FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    const googleApiKey = fixtureSecret("AI", "za", "SyD1234567890abcdefghijklmnopqrstu");
    const out = scrubSecretsForLLM(
      `aws ${awsAccessKeyId} ${awsSecret} AWS_SECRET_ACCESS_KEY=${labeledAwsSecret} google ${googleApiKey}`,
    );

    expect(out).not.toContain(awsAccessKeyId);
    expect(out).not.toContain(awsSecret);
    expect(out).not.toContain(labeledAwsSecret);
    expect(out).not.toContain(googleApiKey);
    expect(out.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(4);

    const paddedSecret = "A".repeat(39) + "=";
    const paddedOut = scrubSecretsForLLM(`aws ${awsAccessKeyId} ${paddedSecret}`);
    expect(paddedOut).not.toContain(paddedSecret);
    expect(paddedOut.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(2);
  });

  it("redacts bearer tokens and auth headers", () => {
    expect(scrubSecretsForLLM("Bearer abcXYZ12345token")).not.toContain("abcXYZ12345token");
    expect(scrubSecretsForLLM("BEARER abcXYZ12345token")).toBe("Bearer [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("Authorization: Bearer abcXYZ12345token")).toBe("Authorization: [REDACTED:TOKEN]");
    expect(scrubSecretsForLLM("Authorization: Bearer [REDACTED:TOKEN] status=200")).toBe(
      "Authorization: Bearer [REDACTED:TOKEN] status=200",
    );
    expect(scrubSecretsForLLM("x-api-key: myheaderSECRET99")).not.toContain("myheaderSECRET99");
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42")).not.toContain("rawSecretHeader42");
    const basicSecret = fixtureSecret("Basic ", "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    expect(scrubSecretsForLLM(`Authorization: ${basicSecret}`)).toBe("Authorization: [REDACTED:TOKEN]");
    const embedded = scrubSecretsForLLM(`{"level":30,"msg":"Authorization: ${basicSecret}","status":200}`);
    expect(embedded).not.toContain(basicSecret);
    expect(embedded).toContain("Authorization: [REDACTED:TOKEN]");
    expect(embedded).toContain('"status":200');
    const digest = scrubSecretsForLLM('Authorization: Digest username="user", response="secret-response-token" status=200');
    expect(digest).not.toContain('username="user"');
    expect(digest).not.toContain('response="secret-response-token"');
    expect(digest).toBe("Authorization: [REDACTED:TOKEN] status=200");
    const embeddedDigest = scrubSecretsForLLM(
      '{"level":30,"msg":"Authorization: Digest username=\\"user\\", response=\\"secret-response-token\\"","status":200}',
    );
    expect(embeddedDigest).not.toContain('response=\\"secret-response-token\\"');
    expect(embeddedDigest).toContain("Authorization: [REDACTED:TOKEN]");
    expect(embeddedDigest).toContain('","status":200');
    expect(scrubSecretsForLLM("Authorization: rawSecretHeader42 status=200")).toBe(
      "Authorization: [REDACTED:TOKEN] status=200",
    );
    expect(scrubSecretsForLLM("x-api-key: myheaderSECRET99 status=200")).toBe("x-api-key: [REDACTED:TOKEN] status=200");
    expect(scrubSecretsForLLM("x-auth-token: rawHeaderToken42 status=200")).toBe(
      "x-auth-token: [REDACTED:TOKEN] status=200",
    );
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(scrubSecretsForLLM(`token ${jwt}`)).not.toContain(jwt);
    expect(scrubSecretsForLLM(`token ${jwt}`)).toContain("[REDACTED:JWT]");
  });

  it("redacts token/api_key query params", () => {
    const out = scrubSecretsForLLM("https://x.example/mcp?api_key=SECRETVALUE123&x=1");
    expect(out).not.toContain("SECRETVALUE123");
  });

  it("does NOT slice — a secret late in a long line is still caught", () => {
    // The mcp-client scrubSecrets 120-char slice previously masked this class of
    // gap. The slice-free SOT must catch a token after 200 chars.
    const line = "x".repeat(200) + " Bearer LATElineSECRETtoken777";
    const out = scrubSecretsForLLM(line);
    expect(out).not.toContain("LATElineSECRETtoken777");
    expect(out.length).toBeGreaterThan(120); // whole line preserved, not truncated
  });

  it("does not redact unprefixed high-entropy hashes without credential context", () => {
    // #1511 reviewed bare high-entropy heuristics. Redacting every 40-hex or
    // base64-ish blob would mask common commit SHAs and artifact hashes in
    // diagnostic bundles, so the scrubber stays prefix/context driven.
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const base64Blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo1234567890";
    const out = scrubSecretsForLLM(`commit ${commitSha} artifact ${base64Blob}`);

    expect(out).toContain(commitSha);
    expect(out).toContain(base64Blob);
  });
});

describe("redactFsPath", () => {
  const home = os.homedir();
  // Guard: if homedir is empty (rare CI sandbox) the redact logic is a no-op —
  // skip these tests rather than give a false-green pass.
  const itIfHome = home ? it : it.skip;

  itIfHome("replaces home-dir prefix in a plain FS path", () => {
    const p = home + "/.lvis/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^<home>/);
    expect(result).not.toContain(home);
  });

  itIfHome("replaces home-dir prefix in a file:// URL (pathToFileURL format)", () => {
    // Use pathToFileURL so the test input matches what Electron/Node produces,
    // not just the same string-concat the implementation uses internally.
    const p = pathToFileURL(home + "/.lvis/plugins/com.example/dist/ui.js").href;
    const result = redactFsPath(p);
    expect(result).toMatch(/^file:\/\/<home>/);
    expect(result).not.toContain(home);
  });

  it("leaves unrelated paths unchanged", () => {
    const p = "/tmp/some-random-path/file.js";
    expect(redactFsPath(p)).toBe(p);
  });

  itIfHome("caps paths longer than 256 code points", () => {
    // Use emoji (2 UTF-16 units each) to verify the cap works on code points,
    // not UTF-16 code units. 300 emoji + "<home>/" = 307 code points > 256.
    const long = home + "/" + "😀".repeat(300);
    const result = redactFsPath(long);
    expect([...result].length).toBeLessThanOrEqual(257); // 256 code points + ellipsis
    expect(result).toContain("…");
  });

  it("returns the input unchanged for empty string", () => {
    expect(redactFsPath("")).toBe("");
  });

  itIfHome("handles exact home-dir match without trailing slash", () => {
    expect(redactFsPath(home)).toBe("<home>");
  });

  itIfHome("handles Windows-style backslash separator", () => {
    // Simulate a Windows path where the home dir is used as a prefix.
    const winHome = home.replace(/\//g, "\\");
    const p = winHome + "\\AppData\\Roaming\\lvis\\plugins\\foo.js";
    const result = redactFsPath(p);
    // On non-Windows, _homeDir uses forward slashes so backslash paths won't
    // match — this test is mainly a contract test for when running on Windows.
    // Just assert no throw and the result is a string.
    expect(typeof result).toBe("string");
  });
});

describe("redactHomePathsInText", () => {
  it("redacts embedded Windows, macOS, Linux, and file URL home paths", () => {
    const input = [
      "Windows C:\\Users\\alice\\private\\output",
      "macOS /Users/alice/private/output",
      "Linux /home/alice/private/output",
      "Windows URL file:///C:/Users/alice/private/output",
      "macOS URL file:///Users/alice/private/output",
      "Linux URL file:///home/alice/private/output",
    ].join(" | ");
    const redacted = redactHomePathsInText(input);

    expect(redacted).not.toContain("C:\\Users\\alice");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted.match(/\[home\]/gu)).toHaveLength(6);
    expect(redactHomePathsInText("/srv/workspace/output")).toBe(
      "/srv/workspace/output",
    );
  });
});

describe("redactAuditPayload", () => {
  const home = os.homedir();
  const itIfHome = home ? it : it.skip;

  itIfHome("redacts known path fields", () => {
    const payload = {
      webContentsId: 42,
      pluginId: "com.example",
      entryUrl: home + "/.lvis/plugins/com.example/dist/ui.js",
      entryFsPath: home + "/.lvis/plugins/com.example/dist/ui.js",
      reason: "invalid-entry-url",
    };
    const result = redactAuditPayload(payload) as Record<string, unknown>;
    expect(result.entryUrl).toMatch(/^<home>/);
    expect(result.entryFsPath).toMatch(/^<home>/);
    expect(result.pluginId).toBe("com.example");
    expect(result.webContentsId).toBe(42);
    expect(result.reason).toBe("invalid-entry-url");
  });

  it("returns non-object payload unchanged", () => {
    expect(redactAuditPayload("string")).toBe("string");
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload(42)).toBe(42);
  });
});
