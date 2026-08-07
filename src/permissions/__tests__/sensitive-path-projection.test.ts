/**
 * The sensitive-path hard-blocklist has ONE authority
 * (`SENSITIVE_PATH_ENTRIES`) and TWO enforcement points that project it: the
 * in-process host-tool guard (glob form, reached here through the REAL tool
 * caller `assertReadableFilePath`) and the OS sandbox read deny floor
 * (`getDefaultSensitiveReadDenyPaths`, literal form).
 *
 * These tests fail if a path is secret on one surface and readable on the
 * other. That drift was real: the sandbox floor denied `~/.git-credentials`,
 * `~/.gitconfig`, `~/.config/gh`, `~/.config/git` and the whole `~/.aws` dir
 * that the host guard let through, while the host guard denied `/etc/shadow`,
 * `~/.config/lvis/hooks` and the REPL/editor histories that the sandbox floor
 * let through.
 *
 * The host assertions go through `assertReadableFilePath` — the guard the
 * builtin file tools actually run — with the anchor root handed in as an
 * allowed directory, so Layer 1 cannot mask a missing Layer 0 deny.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertReadableFilePath } from "../../tools/file-read-core.js";
import { getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import {
  SENSITIVE_PATH_ENTRIES,
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
  type SensitiveEntry,
} from "../sensitive-paths.js";

const FAKE_LVIS_HOME = join(tmpdir(), "lvis-projection-test-home", ".lvis");
const HOME = homedir();
const CWD = join(tmpdir(), "lvis-projection-test-cwd");

function anchorRoot(anchor: SensitiveEntry["anchor"]): string {
  switch (anchor) {
    case "lvis-home":
      return FAKE_LVIS_HOME;
    case "home":
      return HOME;
    case "root":
      return "/";
  }
}

function entryPath(entry: SensitiveEntry): string {
  if (entry.anchor === "root") return "/" + entry.segments.join("/");
  return join(anchorRoot(entry.anchor), ...entry.segments);
}

/**
 * The REAL host-tool read guard. `allowedRoot` is granted at Layer 1 so a
 * `sensitive-path` verdict can only come from Layer 0 — otherwise a missing
 * blocklist row would hide behind a generic `path-not-allowed`.
 */
function hostDeniesAsSensitive(absPath: string, allowedRoot: string): boolean {
  const result = assertReadableFilePath(absPath, CWD, [allowedRoot]);
  return result.ok === false && result.error === "sensitive-path";
}

function sandboxDenies(absPath: string): boolean {
  const folded = caseFoldForMatch(absPath).replace(/\\/g, "/");
  return getDefaultSensitiveReadDenyPaths().some((denied) => {
    const foldedDeny = caseFoldForMatch(denied).replace(/\\/g, "/");
    return folded === foldedDeny || folded.startsWith(foldedDeny + "/");
  });
}

describe("sensitive paths — one table, two projections", () => {
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = FAKE_LVIS_HOME;
  });
  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
  });

  it("denies every table row on BOTH surfaces", () => {
    for (const entry of SENSITIVE_PATH_ENTRIES) {
      const base = entryPath(entry);
      const target = entry.kind === "dir" ? base + "/probe-child" : base;
      const allowedRoot =
        entry.anchor === "root" ? "/" + entry.segments[0] : anchorRoot(entry.anchor);
      expect(
        hostDeniesAsSensitive(target, allowedRoot),
        `host guard must hard-block ${target}`,
      ).toBe(true);
      expect(sandboxDenies(target), `sandbox floor must deny ${target}`).toBe(true);
    }
  });

  // ── The disagreement set, pinned independently of the table ──────────
  //
  // Deleting the corresponding row must red these even if the loop above is
  // still self-consistent.

  describe("paths the OS sandbox denied but the host guard let through", () => {
    it.each([
      ["git credential store", join(HOME, ".git-credentials")],
      ["git global config", join(HOME, ".gitconfig")],
      ["GitHub CLI token", join(HOME, ".config", "gh", "hosts.yml")],
      ["git credential config", join(HOME, ".config", "git", "credentials")],
      ["AWS SSO token cache", join(HOME, ".aws", "sso", "cache", "abc.json")],
    ])("%s is now secret to the host guard too", (_label, target) => {
      expect(hostDeniesAsSensitive(target, HOME)).toBe(true);
      expect(sandboxDenies(target)).toBe(true);
    });

    it("denies the default Electron userData dir on both surfaces", () => {
      // Not a table row (the exact dir is runtime-only), so this pins the two
      // hand-written projections against each other on the default layout.
      const target = getDefaultSensitiveReadDenyPaths().find((p) =>
        p.endsWith("LVIS"),
      );
      expect(target, "sandbox floor must carry an Electron userData dir").toBeTruthy();
      expect(
        hostDeniesAsSensitive(join(target as string, "Partitions", "p", "Cookies"), HOME),
      ).toBe(true);
    });
  });

  describe("paths the host guard denied but the OS sandbox let through", () => {
    it.each([
      ["shadow", "/etc/shadow"],
      ["sudoers", "/etc/sudoers"],
      ["passwd backup", "/etc/passwd-"],
    ])("%s is now denied on the sandbox floor too", (_label, target) => {
      expect(hostDeniesAsSensitive(target, "/etc")).toBe(true);
      expect(sandboxDenies(target)).toBe(true);
    });

    it.each([
      ["hook scripts", join(HOME, ".config", "lvis", "hooks", "pre-tool.sh")],
      ["python history", join(HOME, ".python_history")],
      ["psql history", join(HOME, ".psql_history")],
      ["viminfo", join(HOME, ".viminfo")],
    ])("%s is now denied on the sandbox floor too", (_label, target) => {
      expect(hostDeniesAsSensitive(target, HOME)).toBe(true);
      expect(sandboxDenies(target)).toBe(true);
    });
  });

  // ── Documented one-sided entries stay one-sided, on purpose ──────────

  it("keeps glob-only patterns host-guard-only (bwrap/seatbelt cannot glob)", () => {
    const globOnly = [
      join(CWD, ".env"),
      join(CWD, ".env.production"),
      join(CWD, "id_rsa"),
    ];
    for (const target of globOnly) {
      expect(
        isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(target))),
        `host guard must deny ${target}`,
      ).not.toBeNull();
      expect(sandboxDenies(target), `sandbox floor deliberately skips ${target}`).toBe(
        false,
      );
    }
  });

  it("keeps the recorded Keychain/Cookies sandbox exclusion", () => {
    for (const target of [
      join(HOME, "Library", "Keychains", "login.keychain-db"),
      join(HOME, "Library", "Cookies", "Cookies.binarycookies"),
    ]) {
      expect(hostDeniesAsSensitive(target, HOME)).toBe(true);
      expect(sandboxDenies(target)).toBe(false);
    }
  });

  it("still allows a non-secret path on both surfaces", () => {
    const benign = join(FAKE_LVIS_HOME, "plugins", "hello-world", "README.md");
    expect(hostDeniesAsSensitive(benign, FAKE_LVIS_HOME)).toBe(false);
    expect(sandboxDenies(benign)).toBe(false);
  });
});
