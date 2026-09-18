import { configureHeadlessRuntimeIdentity } from "./main/headless-runtime-identity.js";
import { projectRoot } from "./main/main-paths.js";
import {
  createPermissionAuditProof,
  parsePermissionAuditProofCommand,
} from "./audit/permission-audit-proof.js";
import {
  isPermissionAuditProofArg,
  permissionAuditProofFailureCode,
} from "../scripts/lib/headless-launch-options.mjs";

configureHeadlessRuntimeIdentity(projectRoot);
const argv = process.argv.slice(2);
if (argv.some(isPermissionAuditProofArg)) {
  let verificationStarted = false;
  try {
    const request = parsePermissionAuditProofCommand(argv);
    if (!request) throw new Error("permission audit proof request is unavailable");
    verificationStarted = true;
    const receipt = await createPermissionAuditProof(request.challenge);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch {
    process.stderr.write(`headless: ${permissionAuditProofFailureCode(verificationStarted)}\n`);
    process.exitCode = 1;
  }
} else {
  await import("./headless-host.js");
}
