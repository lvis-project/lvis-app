import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  buildAcceptedAtMap,
  defaultDisabledDir,
  defaultHooksDir,
  defaultLockfilePath,
  diffAgainstLockfile,
  disableHook,
  discoverHooks,
  ensureHooksDirectory,
  persistLockfile,
  readLockfile,
  type DiscoveredHook,
  type HookDiff,
} from "./hook-discovery.js";
import type { ScriptHookManager } from "./script-hook-manager.js";

export interface HookTrustCommandOptions {
  hooksDir?: string;
  disabledDir?: string;
  lockfilePath?: string;
  manager?: ScriptHookManager;
}

export interface HookTrustRow {
  fileName: string;
  hookType: DiscoveredHook["hookType"];
  sha256: string;
  state: "trusted" | "new" | "changed" | "removed" | "disabled";
  previousSha256?: string;
}

export type HookTrustCommandResult =
  | {
      ok: true;
      verb: "list";
      active: HookTrustRow[];
      disabled: HookTrustRow[];
    }
  | {
      ok: true;
      verb: "accept";
      accepted: HookTrustRow;
      trusted: HookTrustRow[];
    }
  | {
      ok: true;
      verb: "disable";
      disabled: HookTrustRow;
      trusted: HookTrustRow[];
    }
  | { ok: false; error: string };

function hooksDir(opts: HookTrustCommandOptions): string {
  return opts.hooksDir ?? defaultHooksDir();
}

function disabledDir(opts: HookTrustCommandOptions): string {
  return opts.disabledDir ?? defaultDisabledDir();
}

function lockfilePath(opts: HookTrustCommandOptions): string {
  return opts.lockfilePath ?? defaultLockfilePath();
}

function validateHookName(fileName: string): string | null {
  if (!/^(pre|post|perm)-[A-Za-z0-9._-]+\.sh$/.test(fileName)) {
    return "hook name must match pre-*.sh, post-*.sh, or perm-*.sh without path separators";
  }
  return null;
}

function rowFromDiff(diff: HookDiff): HookTrustRow {
  return {
    fileName: diff.hook.fileName,
    hookType: diff.hook.hookType,
    sha256: diff.hook.sha256,
    state: diff.state,
    ...(diff.previousSha256 ? { previousSha256: diff.previousSha256 } : {}),
  };
}

function rowFromHook(hook: DiscoveredHook, state: HookTrustRow["state"]): HookTrustRow {
  return {
    fileName: hook.fileName,
    hookType: hook.hookType,
    sha256: hook.sha256,
    state,
  };
}

function snapshot(opts: HookTrustCommandOptions): {
  active: DiscoveredHook[];
  disabled: DiscoveredHook[];
  lockfile: ReturnType<typeof readLockfile>;
  diff: HookDiff[];
} {
  ensureHooksDirectory(hooksDir(opts));
  const active = discoverHooks(hooksDir(opts));
  const disabled = discoverHooks(disabledDir(opts));
  const lockfile = readLockfile(lockfilePath(opts));
  const diff = diffAgainstLockfile(active, lockfile);
  return { active, disabled, lockfile, diff };
}

async function persistTrustedHooks(
  trustedHooks: DiscoveredHook[],
  opts: HookTrustCommandOptions,
  previousAcceptedAt: ReturnType<typeof buildAcceptedAtMap>,
): Promise<HookTrustRow[]> {
  const byName = new Map<string, DiscoveredHook>();
  for (const hook of trustedHooks) byName.set(hook.fileName, hook);
  const trusted = [...byName.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  await persistLockfile(trusted, lockfilePath(opts), previousAcceptedAt);
  opts.manager?.setTrustedHooks(trusted);
  return trusted.map((hook) => rowFromHook(hook, "trusted"));
}

export function listHookTrustState(
  opts: HookTrustCommandOptions = {},
): Extract<HookTrustCommandResult, { verb: "list" }> {
  const { disabled, diff } = snapshot(opts);
  return {
    ok: true,
    verb: "list",
    active: diff.map(rowFromDiff),
    disabled: disabled.map((hook) => rowFromHook(hook, "disabled")),
  };
}

export async function acceptHookTrust(
  fileName: string,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  const invalid = validateHookName(fileName);
  if (invalid) return { ok: false, error: invalid };

  let state = snapshot(opts);
  let target = state.active.find((hook) => hook.fileName === fileName);
  if (!target) {
    const quarantined = state.disabled.find((hook) => hook.fileName === fileName);
    if (!quarantined) return { ok: false, error: `hook not found: ${fileName}` };
    const destination = join(hooksDir(opts), fileName);
    if (existsSync(destination)) {
      return { ok: false, error: `active hook already exists: ${fileName}` };
    }
    renameSync(quarantined.path, destination);
    state = snapshot(opts);
    target = state.active.find((hook) => hook.fileName === fileName);
  }
  if (!target) return { ok: false, error: `hook not found after restore: ${fileName}` };

  const acceptedAt = buildAcceptedAtMap(state.lockfile);
  const alreadyTrusted = state.diff
    .filter((entry) => entry.state === "trusted")
    .map((entry) => entry.hook);
  const trusted = await persistTrustedHooks(
    [...alreadyTrusted, target],
    opts,
    acceptedAt,
  );
  return {
    ok: true,
    verb: "accept",
    accepted: rowFromHook(target, "trusted"),
    trusted,
  };
}

export async function disableHookTrust(
  fileName: string,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  const invalid = validateHookName(fileName);
  if (invalid) return { ok: false, error: invalid };

  const state = snapshot(opts);
  const active = state.active.find((hook) => hook.fileName === fileName);
  const acceptedAt = buildAcceptedAtMap(state.lockfile);
  if (!active) {
    const quarantined = state.disabled.find((hook) => hook.fileName === fileName);
    if (!quarantined) return { ok: false, error: `hook not found: ${fileName}` };
    const trusted = await persistTrustedHooks(
      state.diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook),
      opts,
      acceptedAt,
    );
    return {
      ok: true,
      verb: "disable",
      disabled: rowFromHook(quarantined, "disabled"),
      trusted,
    };
  }

  disableHook(active, disabledDir(opts));
  const next = snapshot(opts);
  const trusted = await persistTrustedHooks(
    next.diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook),
    opts,
    acceptedAt,
  );
  return {
    ok: true,
    verb: "disable",
    disabled: rowFromHook(active, "disabled"),
    trusted,
  };
}
