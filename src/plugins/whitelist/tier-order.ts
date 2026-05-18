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

export type TierOutcome =
  | { kind: "allow" }
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
   * Tier-4 (active-vendor cross-check) is preserved unconditionally so
   * an admin plugin still cannot read a non-active vendor's key — the
   * dynamic per-session vendor identity gate continues to apply.
   */
  installPolicy?: "user" | "admin";
}

/**
 * Run Tier-3 (whitelist registry) then Tier-4 (active-vendor cross-check)
 * in that fixed order. Returns the first deny outcome encountered or
 * `{ kind: "allow" }` when both gates pass.
 *
 * `installPolicy === "admin"` bypasses Tier-3 entirely (admin-install
 * already represents an explicit elevated grant — see field JSDoc on
 * `TierCheckInput`). Tier-4 still runs so vendor cross-check is enforced
 * regardless of install policy.
 *
 * NB: callers MUST still emit their own audit log lines + counter
 * increments — this helper deliberately stays free of those concerns
 * so it can be used from both the boot-context `getSecret` (which has
 * `bootAuditLogger`) and the per-plugin `resolveApiKey` (which has the
 * injected `auditLogger`).
 */
export function runTier3Then4(input: TierCheckInput): TierOutcome {
  if (input.installPolicy === "admin") {
    if (input.vendor !== input.activeProvider) {
      return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
    }
    return { kind: "allow" };
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
