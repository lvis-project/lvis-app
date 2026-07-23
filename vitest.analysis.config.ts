import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rootPath = (p: string) => path.resolve(ROOT, p);

const testFileGlob = "**/*.{test,spec}.{ts,tsx}";
const baseExclude = [
  "node_modules/**",
  "dist/**",
  "plugins/**",
  ".claude/**",
  // Playwright E2E specs run under the `playwright test` runner,
  // not vitest. Excluded here to avoid double-execution + import errors.
  // M4 workflow runs marketplace-e2e.test.ts directly (env M4_E2E=1).
  // Default mode: exclude entire test/e2e/** (Playwright owns it).
  // M4 mode: exclude only Playwright subdirs so vitest picks up the marketplace e2e.
  ...(process.env.M4_E2E === "1"
    ? ["test/e2e/agent-hub/**", "test/e2e/ui/**", "test/e2e/window/**"]
    : ["test/e2e/**"]),
  // Screenshot-capture harness is also a Playwright suite (own config under
  // test/screenshots/playwright.config.ts) — vitest must never collect it.
  "test/screenshots/**",
];
const rendererTestGlobs = [
  `test/renderer/${testFileGlob}`,
  `src/ui/__tests__/${testFileGlob}`,
  `src/ui/renderer/__tests__/${testFileGlob}`,
  `src/ui/renderer/**/__tests__/${testFileGlob}`,
];

/**
 * Renderer split — test infrastructure.
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
    // Cap concurrent workers. Default = CPU count, which on 8-10 core macs
    // multiplied by per-test subprocess fanout (bash.test.ts /
    // executor.test.ts / script-hook-runner.test.ts each spawn shell
    // children) saturates the CPU and causes timing flakes:
    //   - shell stdout chunks arrive late → assertion sees partial output
    //   - script hooks receive stdin slowly → decision flips to deny
    //   - executor Layer-1 approvals race the audit-log subprocess
    // maxWorkers=4 keeps moderate parallelism for the rest of the suite
    // while leaving headroom for each test's spawned subprocesses.
    maxWorkers: 4,
    // Node v25 enabled experimental WebStorage by default. Its
    // `localStorage` getter trips `Warning: --localstorage-file was
    // provided without a valid path` and shadows the jsdom implementation,
    // so tests that touch localStorage (e.g. use-role-presets) start to
    // fail with `localStorage.setItem is not a function` despite running
    // in a jsdom environment. Forcing `--no-experimental-webstorage` on
    // every worker fork restores the pre-v25 behaviour where jsdom owns
    // the `localStorage` global, and is a no-op on Node versions where
    // webstorage is not on by default (e.g. v22 on Windows CI).
    // `--no-experimental-webstorage` is a Node v25+ flag. Older runtimes,
    // including Electron's current embedded Node, reject it as "bad option"
    // before Vitest can collect a test file. Gate on the active test runtime.
    execArgv: (() => {
      const major = parseInt(process.versions.node.split(".")[0], 10);
      return major >= 25 ? ["--no-experimental-webstorage"] : [];
    })(),
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/vitest",
      reporter: ["text-summary", "json-summary", "html"],
      reportOnFailure: true,
      skipFull: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/__tests__/**",
        "**/__probes__/**",
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.d.ts",
      ],
      excludeAfterRemap: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Backend tests were authored against the original Korean strings
          // (dialogs, tool descriptions, prompts). After the i18n migration
          // these resolve through t() with English as the default; this setup
          // pins the runtime locale to Korean for node tests so the existing
          // Korean assertions stay valid. Tests that specifically exercise the
          // i18n default (English) set the locale explicitly themselves.
          setupFiles: ["./src/i18n/testing/vitest-locale-ko.ts"],
          include: [
            `src/**/__tests__/${testFileGlob}`,
            `test/${testFileGlob}`,
          ],
          exclude: [
            ...baseExclude,
            ...rendererTestGlobs,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          // Renderer tests were authored against the original Korean UI
          // strings. After the i18n migration those strings resolve through
          // t() with English as the default; this setup pins the runtime
          // locale to Korean for renderer tests so the existing Korean
          // assertions stay valid (and also verify the Korean catalog wiring).
          setupFiles: ["./src/i18n/testing/vitest-locale-ko.ts"],
          include: rendererTestGlobs,
          exclude: baseExclude,
        },
      },
    ],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
    // Pin react / ajv / pino to their concrete entry files so vitest resolves a
    // single copy regardless of how the importer specifies them.
    alias: {
      "react/jsx-dev-runtime": rootPath("node_modules/react/jsx-dev-runtime.js"),
      "react/jsx-runtime": rootPath("node_modules/react/jsx-runtime.js"),
      "react-dom/client": rootPath("node_modules/react-dom/client.js"),
      "react-dom": rootPath("node_modules/react-dom/index.js"),
      react: rootPath("node_modules/react/index.js"),
      "ajv-formats": rootPath("node_modules/ajv-formats/dist/index.js"),
      ajv: rootPath("node_modules/ajv/dist/ajv.js"),
      pino: rootPath("node_modules/pino/pino.js"),
    },
  },
});
