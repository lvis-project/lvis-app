export function isPermissionAuditProofArg(arg: string): boolean;
export function permissionAuditProofFailureCode(
  verificationStarted: boolean,
): "permission-audit-proof:invalid-arguments" | "permission-audit-proof:verification-failed";
export function headlessLaunchArgs(args: readonly string[]): string[] | null;
