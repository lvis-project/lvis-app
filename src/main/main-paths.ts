/**
 * Resolved filesystem roots for the packaged/bundled main process.
 *
 * The esbuild bundle emits every `src/main/*` module into a single
 * `dist/src/main/main.js`, so `import.meta.url` here resolves to that output
 * file exactly as it did when these constants lived inline in `src/main.ts`.
 * Centralising them keeps a single source of truth shared by the entry, the
 * main window, and the settings window.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
/** Directory of the bundled main entry (`dist/src/main`). */
export const mainDir = dirname(__filename);
/** `dist` root — two levels up from `dist/src/main`. */
export const distRoot = resolve(mainDir, "..", "..");
/** Project root — one level above `dist`. */
export const projectRoot = resolve(distRoot, "..");
