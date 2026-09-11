import { afterEach } from "vitest";
import { buildHostShellExecutionPlan } from "../../../permissions/host-shell-execution-plan.js";
import { disposePreparedShellInvocation, prepareShellInvocation, type PreparedShellInvocation } from "../../prepared-shell-invocation.js";

const prepared: PreparedShellInvocation[] = [];
afterEach(() => { for (const handle of prepared.splice(0)) disposePreparedShellInvocation(handle); });

/** The native helper owns wrapping/spawn; preparation is now an earlier boundary. */
export function prepareSandboxFixture(command: string, cwd: string): PreparedShellInvocation {
  const plan = buildHostShellExecutionPlan({ platform: process.platform, requestedSandbox: true,
    activeCapability: { kind: "asrt", confidence: "verified", platform: process.platform, reason: "Controlled sandbox fixture",
      confines: { filesystem: true, process: true, network: true } } });
  const handle = prepareShellInvocation({ command, executionCwd: cwd, resolvedCwd: cwd, plan });
  prepared.push(handle);
  return handle;
}
