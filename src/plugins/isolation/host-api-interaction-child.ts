/**
 * The child's half of the members that put something in front of the user, or
 * decide whether an action is permitted
 * (`docs/blueprints/plugin-process-isolation.md` §3.4).
 *
 * All seven declare `arguments: "plain-json"` and settle as `plain-json` or
 * `void`, so one relay serves all of them: the arguments go on the wire as they
 * are, and whatever the host answered comes back as it is. That uniformity is
 * DERIVED from the contract SOT rather than assumed — {@link assertRelayable}
 * refuses to build a stub for a path whose contract says something else, so a
 * member that later grows an `encoded` argument cannot silently keep using a
 * relay that would drop the encoding.
 *
 * WHY NOTHING IS RE-CHECKED HERE. The host validates these arguments itself and
 * that validation is the decision (see `host-api-interaction-paths.ts`). A
 * child-side pre-check would be a second copy of a host rule, sitting in the
 * least-trusted process — the worst possible place for a security rule to live,
 * and a place a plugin can edit.
 *
 * ELECTRON-FREE. Imported by the child, which is a plain Node process.
 */
import {
  HOSTAPI_PATH_CONTRACTS,
  type HostApiPath,
} from "./host-api-path-contracts.js";
import type { HostApiCaller } from "./plugin-child-runtime.js";

/** The members this group carries. */
export const INTERACTION_HOSTAPI_PATHS = [
  "openExternalUrl",
  "openAuthWindow",
  "openAuthPartitionViewer",
  "clearAuthPartition",
  "triggerConversation",
  "agentApproval.request",
  "agentApproval.respond",
] as const satisfies readonly HostApiPath[];

/** One of the seven. */
export type InteractionHostApiPath = (typeof INTERACTION_HOSTAPI_PATHS)[number];

/**
 * Refuse to relay a member whose contract does not say "send it as it is".
 *
 * Fail-closed at stub construction rather than at the call: a path that gains
 * an `encoded` axis would otherwise keep crossing through a relay that does no
 * encoding, and the symptom would be a wrong value rather than a failure.
 */
function assertRelayable(path: InteractionHostApiPath): void {
  const contract = HOSTAPI_PATH_CONTRACTS[path];
  if (
    contract.arguments !== "plain-json"
    || (contract.result !== "plain-json" && contract.result !== "void")
    || contract.lifetime !== "none"
  ) {
    throw new Error(
      `[host-api-interaction-child] '${path}' no longer crosses as plain JSON `
        + `(arguments=${contract.arguments} result=${contract.result} `
        + `lifetime=${contract.lifetime}) — it needs a stub of its own`,
    );
  }
}

/**
 * Build this group's child-side stubs.
 *
 * Every stub goes through {@link HostApiCaller}, which is the one place the
 * envelope is stamped and the one place a reply's error identity is rebuilt.
 * A stub that assembled its own request would be a second place the generation
 * is claimed, and the generation is what the host checks the call against.
 */
export function createInteractionChildMembers(
  call: HostApiCaller,
): Record<InteractionHostApiPath, (...args: unknown[]) => Promise<unknown>> {
  const members = {} as Record<
    InteractionHostApiPath,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const path of INTERACTION_HOSTAPI_PATHS) {
    assertRelayable(path);
    members[path] = (...args: unknown[]) => call(path, args);
  }
  return members;
}
