import { compareSemver, appVersionSatisfiesMin } from "../shared/semver-compare.js";
import { IncompatibleAppVersionError } from "./types.js";
import type { InstallPolicy, PluginMarketplaceItem } from "./types.js";

export type PluginUpdateCondition =
  | Readonly<{ kind: "catalog_unavailable" }>
  | Readonly<{ kind: "no_candidate" }>
  | Readonly<{ kind: "installed_state_unreadable" }>
  | Readonly<{ kind: "current"; relation: "equal" | "installed_newer" }>
  | Readonly<{
      kind: "blocked_by_app";
      currentAppVersion: string;
      minAppVersion?: string;
      message?: string;
    }>
  | Readonly<{ kind: "blocked_by_channel" }>
  | Readonly<{ kind: "transaction_pending" }>
  | Readonly<{ kind: "eligible_user_install" }>
  | Readonly<{ kind: "eligible_user_update" }>
  | Readonly<{ kind: "eligible_managed_install" }>
  | Readonly<{ kind: "eligible_managed_boot_update" }>;

export interface PluginUpdateConditionInput {
  readonly appVersion: string;
  readonly catalogAvailable?: boolean;
  readonly canaryOptIn?: boolean;
  readonly installed: Readonly<
    | { presence: "absent" }
    | { presence: "present"; version?: string; transactionPending?: boolean }
  >;
  readonly candidate?: Readonly<
    Pick<
      PluginMarketplaceItem,
      "version" | "channel" | "installPolicy" | "requires" | "upgradeRequired"
    >
  > | null;
}

const CONDITIONS = {
  catalogUnavailable: Object.freeze({ kind: "catalog_unavailable" } as const),
  blockedByChannel: Object.freeze({ kind: "blocked_by_channel" } as const),
  transactionPending: Object.freeze({ kind: "transaction_pending" } as const),
  eligibleUserInstall: Object.freeze({ kind: "eligible_user_install" } as const),
  eligibleUserUpdate: Object.freeze({ kind: "eligible_user_update" } as const),
  eligibleManagedInstall: Object.freeze({ kind: "eligible_managed_install" } as const),
  eligibleManagedBootUpdate: Object.freeze({ kind: "eligible_managed_boot_update" } as const),
};

function normalizeInstallPolicy(policy: InstallPolicy | undefined): InstallPolicy {
  return policy === "admin" ? "admin" : "user";
}

export function resolvePluginUpdateCondition(
  input: PluginUpdateConditionInput,
): PluginUpdateCondition {
  if (input.catalogAvailable === false) return CONDITIONS.catalogUnavailable;
  if (input.installed.presence === "present" && input.installed.transactionPending) {
    return CONDITIONS.transactionPending;
  }

  const candidate = input.candidate;
  if (!candidate) return Object.freeze({ kind: "no_candidate" });

  const upgradeRequired = candidate.upgradeRequired;
  if (upgradeRequired) {
    return Object.freeze({
      kind: "blocked_by_app",
      currentAppVersion: input.appVersion,
      ...(upgradeRequired.minAppVersion
        ? { minAppVersion: upgradeRequired.minAppVersion }
        : {}),
      ...(!upgradeRequired.minAppVersion ? { message: upgradeRequired.message } : {}),
    });
  }

  const minAppVersion = candidate.requires?.minAppVersion;
  if (minAppVersion && !appVersionSatisfiesMin(input.appVersion, minAppVersion)) {
    return Object.freeze({
      kind: "blocked_by_app",
      currentAppVersion: input.appVersion,
      minAppVersion,
    });
  }

  if (candidate.channel === "canary" && !input.canaryOptIn) {
    return CONDITIONS.blockedByChannel;
  }

  const managed = normalizeInstallPolicy(candidate.installPolicy) === "admin";
  if (input.installed.presence === "absent") {
    return managed ? CONDITIONS.eligibleManagedInstall : CONDITIONS.eligibleUserInstall;
  }
  if (!input.installed.version) {
    return Object.freeze({ kind: "installed_state_unreadable" });
  }
  if (!candidate.version) return Object.freeze({ kind: "no_candidate" });
  const versionComparison = compareSemver(candidate.version, input.installed.version);
  if (versionComparison <= 0) {
    return Object.freeze({
      kind: "current",
      relation: versionComparison === 0 ? "equal" : "installed_newer",
    });
  }
  return managed
    ? CONDITIONS.eligibleManagedBootUpdate
    : CONDITIONS.eligibleUserUpdate;
}

export function assertPluginCandidateAppCompatible(
  candidate: Pick<PluginMarketplaceItem, "version" | "requires" | "upgradeRequired">,
  appVersion: string,
): void {
  const condition = resolvePluginUpdateCondition({
    appVersion,
    installed: { presence: "absent" },
    candidate,
  });
  if (condition.kind !== "blocked_by_app") return;
  if (condition.minAppVersion) {
    throw new IncompatibleAppVersionError(
      condition.minAppVersion,
      condition.currentAppVersion,
    );
  }
  throw new Error(condition.message ?? "This plugin requires an LVIS app update.");
}

export function isNewerPluginVersion(candidate: string, installed: string): boolean {
  return compareSemver(candidate, installed) > 0;
}
