const PERMISSION_AUDIT_PROOF_FLAG = "--verify-permission-audit";

/** Reserve every proof-looking form so malformed input cannot boot the host. */
export function isPermissionAuditProofArg(arg) {
  return arg.startsWith(PERMISSION_AUDIT_PROOF_FLAG);
}

export function permissionAuditProofFailureCode(verificationStarted) {
  return verificationStarted
    ? "permission-audit-proof:verification-failed"
    : "permission-audit-proof:invalid-arguments";
}

/** Select the native command before loading or launching the desktop runtime. */
export function headlessLaunchArgs(args) {
  const nativeCommand = args.some((arg) =>
    arg === "--exec" || arg.startsWith("--exec=") ||
    arg === "--exec-operator-attestation" || arg.startsWith("--exec-operator-attestation=") ||
    arg === "--exec-workload-broker" || arg.startsWith("--exec-workload-broker=") ||
    arg === "--exec-workload-capability" || arg.startsWith("--exec-workload-capability=") ||
    arg === "--set-secret" || arg.startsWith("--set-secret=") ||
    arg === "--serve" || arg === "--runtime-check" ||
    isPermissionAuditProofArg(arg));
  if (!nativeCommand) return null;
  // The desktop wrapper accepts its main module as the first positional arg.
  return args.filter((arg, index) => !(index === 0 && !arg.startsWith("--")));
}
