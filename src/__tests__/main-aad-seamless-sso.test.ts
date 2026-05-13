/**
 * Regression guard — `auth-server-allowlist` switch in `src/main.ts` MUST
 * stay scoped to two exact Microsoft AAD apex hosts, and MUST NOT add the
 * `auth-negotiate-delegate-allowlist` companion switch.
 *
 * Failure modes this catches:
 *   - A future edit re-introduces a `*` glob (e.g. `*login.microsoftonline.com`)
 *     which Chromium's allowlist syntax matches as "any sequence including
 *     dots" — `evil-login.microsoftonline.com` would silently be admitted.
 *   - Anyone adding `--auth-negotiate-delegate-allowlist` to "unblock
 *     downstream forwarding" turns the narrow 1-hop Kerberos response into
 *     unconstrained delegation (ticket forwarded to whatever the first
 *     host wants).
 *   - The host list silently grows past the security-reviewed scope.
 *
 * We assert by source inspection because `main.ts` registers Electron event
 * listeners at module load and cannot be imported in a unit test context
 * (mirrors `main-single-instance-gate.test.ts` precedent).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("main.ts — AAD Seamless SSO allowlist invariant", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  it("declares AAD_NEGOTIATE_HOSTS as a 2-entry tuple with exact apex hosts", () => {
    const m = source.match(
      /export\s+const\s+AAD_NEGOTIATE_HOSTS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
    );
    expect(m, "AAD_NEGOTIATE_HOSTS const block must exist").not.toBeNull();
    const body = m![1];
    const entries = (body.match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1));
    expect(entries).toEqual([
      "login.microsoftonline.com",
      "autologon.microsoftazuread-sso.com",
    ]);
    // No `*` glob — Chromium would over-match (`evil-login.microsoftonline.com`).
    for (const e of entries) {
      expect(e, `entry "${e}" must not contain wildcard`).not.toMatch(/[*?]/);
    }
  });

  it("registers the `auth-server-allowlist` switch exactly once", () => {
    const matches = source.match(/appendSwitch\(\s*"auth-server-allowlist"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("does NOT register `auth-negotiate-delegate-allowlist` (no Kerberos delegation)", () => {
    expect(source).not.toMatch(/"auth-negotiate-delegate-allowlist"/);
    expect(source).not.toMatch(/"--auth-negotiate-delegate-allowlist"/);
  });

  it("gates the switch behind `LVIS_DISABLE_AAD_SSO` env-var opt-out", () => {
    expect(source).toMatch(/process\.env\.LVIS_DISABLE_AAD_SSO\s*!==\s*"1"/);
  });
});
