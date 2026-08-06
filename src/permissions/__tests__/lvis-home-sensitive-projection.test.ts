/**
 * The LVIS-home sensitive namespace has ONE authority
 * (`LVIS_HOME_SENSITIVE_ENTRIES`) and TWO enforcement points that project it:
 * the in-process host-tool guard (`isSensitivePath`, glob form) and the OS
 * sandbox read deny floor (`getDefaultSensitiveReadDenyPaths`, literal form).
 *
 * These tests fail if a `~/.lvis/…` path is secret on one surface and readable
 * on the other — the exact drift that made `~/.lvis/routine/*` and
 * `~/.lvis/plugins/auth-partitions.json` host-readable while the sandbox
 * denied them.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import {
  LVIS_HOME_SENSITIVE_ENTRIES,
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../sensitive-paths.js";

const FAKE_LVIS_HOME = join(tmpdir(), "lvis-projection-test-home", ".lvis");

function hostDenies(absPath: string): string | null {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absPath)));
}

function sandboxDenies(absPath: string): boolean {
  const folded = caseFoldForMatch(absPath);
  return getDefaultSensitiveReadDenyPaths().some((denied) => {
    const foldedDeny = caseFoldForMatch(denied);
    return folded === foldedDeny || folded.startsWith(foldedDeny + "/") ||
      folded.startsWith(foldedDeny + "\\");
  });
}

describe("LVIS-home sensitive namespace — one table, two projections", () => {
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
    for (const entry of LVIS_HOME_SENSITIVE_ENTRIES) {
      const target = entry.kind === "dir"
        ? join(FAKE_LVIS_HOME, ...entry.segments, "probe-child")
        : join(FAKE_LVIS_HOME, ...entry.segments);
      expect(hostDenies(target), `host guard must deny ${target}`).not.toBeNull();
      expect(sandboxDenies(target), `sandbox floor must deny ${target}`).toBe(true);
    }
  });

  // Content pin, independent of the table: deleting a row must red these.
  it.each([
    ["routine", join(FAKE_LVIS_HOME, "routine", "session-1.jsonl")],
    ["auth partitions", join(FAKE_LVIS_HOME, "plugins", "auth-partitions.json")],
    ["secrets", join(FAKE_LVIS_HOME, "secrets", "k.key")],
    ["sessions", join(FAKE_LVIS_HOME, "sessions", "abc.jsonl")],
    ["audit", join(FAKE_LVIS_HOME, "audit", "today.jsonl")],
    ["audit log", join(FAKE_LVIS_HOME, "audit.log")],
    ["settings", join(FAKE_LVIS_HOME, "settings.json")],
    ["permissions", join(FAKE_LVIS_HOME, "permissions", "cache.json")],
    ["permissions file", join(FAKE_LVIS_HOME, "permissions.json")],
    ["policy", join(FAKE_LVIS_HOME, "policy.json")],
    ["certs", join(FAKE_LVIS_HOME, "certs", "ca.pem")],
    ["keys", join(FAKE_LVIS_HOME, "keys", "sign.key")],
    ["legacy secrets file", join(FAKE_LVIS_HOME, "lvis-secrets.json")],
  ])("%s is secret to the host guard and to the sandbox floor", (_label, target) => {
    expect(hostDenies(target)).not.toBeNull();
    expect(sandboxDenies(target)).toBe(true);
  });

  it("still allows a non-secret LVIS-home path on both surfaces", () => {
    const benign = join(FAKE_LVIS_HOME, "plugins", "hello-world", "README.md");
    expect(hostDenies(benign)).toBeNull();
    expect(sandboxDenies(benign)).toBe(false);
  });
});
