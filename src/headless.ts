import { configureHeadlessRuntimeIdentity } from "./main/headless-runtime-identity.js";
import { projectRoot } from "./main/main-paths.js";
import {
  createPermissionAuditProof,
  createPermissionAuditSelfTest,
  parsePermissionAuditProofCommand,
  parsePermissionAuditSelfTestCommand,
} from "./audit/permission-audit-proof.js";
import {
  isPermissionAuditProofArg,
  isPermissionAuditSelfTestArg,
  permissionAuditProofFailureCode,
} from "../scripts/lib/headless-launch-options.mjs";

const argv = process.argv.slice(2);
if (argv.some(isPermissionAuditSelfTestArg)) {
  try {
    const request = parsePermissionAuditSelfTestCommand(argv);
    if (!request) throw new Error("permission audit self-test request is unavailable");
    configureHeadlessRuntimeIdentity(projectRoot);
    process.stdout.write(`${JSON.stringify(await createPermissionAuditSelfTest(request.challenge))}\n`);
  } catch {
    process.stderr.write("headless: permission-audit-self-test:failed\n");
    process.exitCode = 1;
  }
} else if (argv.some(isPermissionAuditProofArg)) {
  let verificationStarted = false;
  try {
    const request = parsePermissionAuditProofCommand(argv);
    if (!request) throw new Error("permission audit proof request is unavailable");
    verificationStarted = true;
    configureHeadlessRuntimeIdentity(projectRoot);
    const receipt = await createPermissionAuditProof(request.challenge);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch {
    process.stderr.write(`headless: ${permissionAuditProofFailureCode(verificationStarted)}\n`);
    process.exitCode = 1;
  }
} else {
  configureHeadlessRuntimeIdentity(projectRoot);
  await import("./headless-host.js");
}
