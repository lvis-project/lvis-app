import { defineConfig } from "vitest/config";
import path from "node:path";

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
    testTimeout: 15000,
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
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
    // SDK is installed from GitHub — its prepare (tsup) script may not run
    // in CI without trusted-dependencies. Point vitest directly at the SDK
    // TypeScript sources so the dist/ absence does not break test imports.
    alias: {
      "@lvis/plugin-sdk/ui/tokens": path.resolve("node_modules/@lvis/plugin-sdk/src/ui/tokens/index.ts"),
      "@lvis/plugin-sdk/ui": path.resolve("node_modules/@lvis/plugin-sdk/src/ui/index.ts"),
      "@lvis/plugin-sdk": path.resolve("node_modules/@lvis/plugin-sdk/src/index.ts"),
    },
  },
});
