export declare const APP_TYPECHECK_TEST_RATCHET_SCRIPTS: readonly [
  "check:typecheck-tests:self-test",
  "check:typecheck-tests",
];

export declare const APP_TYPECHECK_GATE_SCRIPTS: readonly [
  "typecheck",
  "check:typecheck-tests:self-test",
  "check:typecheck-tests",
];

export declare function getMissingPackageScripts(
  scriptNames: readonly string[],
  hasPackageScript: (scriptName: string) => boolean,
): string[];
