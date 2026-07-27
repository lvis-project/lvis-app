// The test-typecheck ratchet is a required companion to the production
// typecheck. Keep this list shared by every non-documentation pre-push path so
// a fast path cannot silently lose the CI guard.
export const APP_TYPECHECK_TEST_RATCHET_SCRIPTS = Object.freeze([
  "check:typecheck-tests:self-test",
  "check:typecheck-tests",
]);

export const APP_TYPECHECK_GATE_SCRIPTS = Object.freeze([
  "typecheck",
  ...APP_TYPECHECK_TEST_RATCHET_SCRIPTS,
]);

export function getMissingPackageScripts(scriptNames, hasPackageScript) {
  return scriptNames.filter((scriptName) => !hasPackageScript(scriptName));
}
