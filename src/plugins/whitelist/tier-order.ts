/**
 * #893 Ralph cycle 1 MEDIUM — single SOT for the Tier-3 / Tier-4 ordering
 * used by both `plugin-runtime.ts:getSecret` and
 * `src/main/host-api/resolve-api-key.ts:resolveApiKey`.
 *
 * Order: Tier-3 (whitelist registry) BEFORE Tier-4 (active-vendor
 * cross-check). Rationale — the whitelist is a coarse, signed,
 * statically-declared ACL; the vendor cross-check is dynamic per-call
 * state driven by `settings.llm.provider`. Running the coarse ACL first
 * keeps the dynamic per-session vendor identity from leaking through the
 * deny-reason channel of an unwhitelisted plugin.
 *
 * The helper itself is intentionally tiny — it returns a discriminated
 * union describing whether to continue or which reason to deny with;
 * callers handle audit logging + counter emission since those touch
 * call-site-specific context (boot audit logger vs. injected
 * `auditLogger`). Centralizing only the ORDER + RATIONALE here keeps
 * the two paths in lockstep without forcing a shared logging surface.
 */
import { whitelistRegistry } from "./whitelist-registry.js";

/**
 * #958 round-1 security MEDIUM — `via` discriminator on the `allow`
 * variant so the audit trail can record WHICH gate path produced the
 * grant. Today the only non-default path is `"admin-bypass"` (Tier-3
 * skipped because `installPolicy === "admin"`). Adding new bypass
 * sources later means new union members on this field — callers
 * pattern-match exhaustively so a new variant is a compile-time error
 * at every audit/counter site.
 *
 * Default `allow` (`via` undefined) means "all four tiers ran and
 * passed". Operators reading the audit log can therefore distinguish
 * a regular grant from one that skipped the signed whitelist ACL.
 */
export type TierOutcome =
  | { kind: "allow"; via?: "admin-bypass" }
  | {
      kind: "deny";
      tier: "tier-3" | "tier-4";
      reason:
        | "not-whitelisted"
        | "manifest-sha-mismatch"
        | "whitelist-unreachable"
        | "whitelist-stale-exceeded"
        | "vendor-mismatch";
    };

export interface TierCheckInput {
  pluginId: string;
  key: string;
  manifestSha256?: string;
  installedManifestSha256?: string;
  vendor: string;
  activeProvider: string;
  /**
   * #955 follow-up — when the plugin declared `installPolicy: "admin"` in
   * its manifest, the user (or operator) has explicitly accepted an
   * elevated install grant. In that mode the marketplace publish itself
   * is the policy decision, and the separate Tier-3 signed whitelist
   * registry ACL is redundant — it is meant to keep `user`-installed
   * plugins from reading host secrets they were never approved for.
   *
   * Tier-4 (active-vendor cross-check) is preserved unconditionally.
   * Admin mode also preserves the install-time manifest SHA pin: the
   * bypass applies only to the signed `hostSecrets.read` ACL, not to
   * post-install plugin.json tamper detection.
   */
  installPolicy?: "user" | "admin";
}

/**
 * Run Tier-3 (whitelist registry) then Tier-4 (active-vendor cross-check)
 * in that fixed order. Returns the first deny outcome encountered or
 * `{ kind: "allow" }` when both gates pass.
 *
 * `installPolicy === "admin"` bypasses the Tier-3 host-secret ACL only.
 * The install-time manifest SHA pin still runs before Tier-4 so an
 * elevated marketplace grant cannot silently survive a plugin.json swap.
 *
 * NB: callers MUST still emit their own audit log lines + counter
 * increments — this helper deliberately stays free of those concerns
 * so it can be used from both the boot-context `getSecret` (which has
 * `bootAuditLogger`) and the per-plugin `resolveApiKey` (which has the
 * injected `auditLogger`).
 */
export function runTier3Then4(input: TierCheckInput): TierOutcome {
  if (input.installPolicy === "admin") {
    if (
      !input.manifestSha256 ||
      !input.installedManifestSha256 ||
      input.manifestSha256.toLowerCase() !== input.installedManifestSha256.toLowerCase()
    ) {
      return { kind: "deny", tier: "tier-3", reason: "manifest-sha-mismatch" };
    }
    if (input.vendor !== input.activeProvider) {
      return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
    }
    // #958 round-1 security MEDIUM — mark this allow as having taken the
    // admin-bypass branch so callers can emit an explicit audit line +
    // counter for anomaly detection. The signed Tier-3 ACL was NOT
    // consulted; the install-time manifest SHA pin and Tier-4 did run.
    return { kind: "allow", via: "admin-bypass" };
  }
  const decision = whitelistRegistry.isAllowed(
    input.pluginId,
    input.key,
    input.manifestSha256,
  );
  if (decision.kind === "deny") {
    return { kind: "deny", tier: "tier-3", reason: decision.reason };
  }
  if (input.vendor !== input.activeProvider) {
    return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
  }
  return { kind: "allow" };
}
