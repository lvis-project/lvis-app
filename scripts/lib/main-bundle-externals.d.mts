/**
 * Types for the JavaScript build script `main-bundle-externals.mjs`.
 *
 * The list is authored in `.mjs` because the build runs it directly under node,
 * with no compile step; this declaration is what lets the confined-child smoke
 * test import the SAME list instead of restating it in TypeScript.
 */
export declare const MAIN_BUNDLE_EXTERNALS: readonly string[];
