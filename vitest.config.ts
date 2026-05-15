import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rootPath = (p: string) => path.resolve(ROOT, p);

/**
 * Phase 1 renderer split — test infrastructure.
 *
 * Renderer tests (jsdom + RTL) live under test/renderer/**.
 * All other tests (main/boot/ipc-bridge) continue to run under the default
 * node environment.
 */
export default defineConfig({
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    testTimeout: 45000,
    hookTimeout: 45000,
    // Node v25 enabled experimental WebStorage by default. Its
    // `localStorage` getter trips `Warning: --localstorage-file was
    // provided without a valid path` and shadows the jsdom implementation,
    // so tests that touch localStorage (e.g. use-role-presets) start to
    // fail with `localStorage.setItem is not a function` despite running
    // in a jsdom environment. Forcing `--no-experimental-webstorage` on
    // every worker fork restores the pre-v25 behaviour where jsdom owns
    // the `localStorage` global, and is a no-op on Node versions where
    // webstorage is not on by default (e.g. v22 on Windows CI).
    poolOptions: {
      forks: { execArgv: ["--no-experimental-webstorage"] },
      // `threads` is forward-defense for a future `pool: "threads"` flip —
      // vitest 2.x defaults to `forks`, so this key is currently dead but
      // mirroring `forks` keeps the fix portable if the pool is ever switched.
      threads: { execArgv: ["--no-experimental-webstorage"] },
    },
    environment: "node",
    environmentMatchGlobs: [
      ["test/renderer/**", "jsdom"],
      ["src/ui/__tests__/**", "jsdom"],
      ["src/ui/renderer/__tests__/**", "jsdom"],
      ["src/ui/renderer/**/__tests__/**", "jsdom"],
    ],
    include: [
      "src/**/__tests__/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "plugins/**",
      ".claude/**",
      // Playwright E2E specs run under the `playwright test` runner,
      // not vitest. Excluded here to avoid double-execution + import errors.
      "test/e2e/**",
    ],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
    // SDK is installed from GitHub — its prepare (tsup) script may not run
    // in CI without trusted-dependencies. Point vitest directly at the SDK
    // TypeScript sources so the dist/ absence does not break test imports.
    alias: {
      "react/jsx-dev-runtime": rootPath("node_modules/react/jsx-dev-runtime.js"),
      "react/jsx-runtime": rootPath("node_modules/react/jsx-runtime.js"),
      "react-dom/client": rootPath("node_modules/react-dom/client.js"),
      "react-dom": rootPath("node_modules/react-dom/index.js"),
      react: rootPath("node_modules/react/index.js"),
      "ajv-formats": rootPath("node_modules/ajv-formats/dist/index.js"),
      ajv: rootPath("node_modules/ajv/dist/ajv.js"),
      pino: rootPath("node_modules/pino/pino.js"),
      "@lvis/plugin-sdk/ui/tokens": rootPath("node_modules/@lvis/plugin-sdk/src/ui/tokens/index.ts"),
      "@lvis/plugin-sdk/ui": rootPath("node_modules/@lvis/plugin-sdk/src/ui/index.ts"),
      "@lvis/plugin-sdk": rootPath("node_modules/@lvis/plugin-sdk/src/index.ts"),
    },
  },
});
