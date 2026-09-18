export const HEADLESS_FORBIDDEN_INHERITED_ENV: readonly string[];
export function prepareHeadlessLaunchEnv<T extends Record<string, string | undefined>>(env: T): T;
export function isPermissionAuditProofArg(arg: string): boolean;
export function isPermissionAuditSelfTestArg(arg: string): boolean;
export function permissionAuditProofFailureCode(
  verificationStarted: boolean,
): "permission-audit-proof:invalid-arguments" | "permission-audit-proof:verification-failed";
export function headlessLaunchArgs(args: readonly string[]): string[] | null;
