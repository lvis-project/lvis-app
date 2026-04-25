import { defineConfig } from "vitest/config";

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
      // Playwright UI E2E specs run under the `playwright test` runner,
      // not vitest. Excluded here to avoid double-execution + import errors.
      "test/e2e/ui/**",
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
  },
});
