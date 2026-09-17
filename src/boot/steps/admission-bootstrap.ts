/**
 * Boot step: warm the plugin admission catalog.
 *
 * Structurally a sibling of `revocation-bootstrap.ts`, but it is NOT the same
 * kind of step, and the difference is worth stating because the file name
 * suggests otherwise.
 *
 * The revocation bootstrap has an ordering REQUIREMENT: the LOAD-boundary gate
 * runs inside `pluginRuntime.startAll()` and must see a populated registry the
 * first time it runs, so booting without it would let a revoked plugin load
 * once. Admission has no load-boundary twin — it is consulted only at install
 * — so this step is a LATENCY OPTIMISATION. The gate itself is
 * `admissionRegistry.ensureFresh()`, awaited by the install path, because a
 * device that boots and then installs two days later must not install against
 * the document it warmed at boot.
 *
 * Consequently, skipping or failing this step cannot weaken the control. It
 * can only make the first install of a session slower.
 */
import { admissionRegistry } from "../../plugins/admission/admission-registry.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { readDevelopmentEnvVar } from "../dev-flags.js";

export interface AdmissionBootstrapInput {
  userDataPath: string;
  bootAuditLogger: AuditLogger;
  /** Authoritative host packaging state; never derived from process.env. */
  packaged: boolean;
  /** Transport for the document GETs — Chromium's stack, from `ctx.singleHopNetworkFetch`. */
  networkFetch: typeof fetch;
  /** Online toggle — disabled in tests or user-selected offline mode. */
  online?: boolean;
  /** App-shutdown AbortSignal, aborts an in-flight fetch on quit. */
  appShutdownSignal?: AbortSignal;
}

function isOnlineByDefault(packaged: boolean): boolean {
  // Source/E2E runs may opt out of the public CDN. Offline here does not admit
  // anything: it means the registry has only its disk cache, and an install
  // with no valid cached document is refused. Packaged builds ignore the flag
  // even if early environment scrubbing is bypassed.
  if (readDevelopmentEnvVar("LVIS_ADMISSION_OFFLINE", process.env, packaged) === "1") return false;
  return true;
}

/**
 * Warm the admission registry. Resolves on every path and never throws — a
 * network blip must not crash boot, and cannot admit anything either.
 */
export async function wireAdmissionRegistry(input: AdmissionBootstrapInput): Promise<void> {
  const { bootAuditLogger } = input;
  const online = input.online ?? isOnlineByDefault(input.packaged);
  const userDataDir = input.userDataPath;

  await admissionRegistry.init({
    userDataDir,
    online,
    networkFetch: input.networkFetch,
    ...(input.appShutdownSignal ? { signal: input.appShutdownSignal } : {}),
    audit: (line: string) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "info",
          input: line,
        });
      } catch {
        /* audit must not break boot */
      }
    },
  });
}
