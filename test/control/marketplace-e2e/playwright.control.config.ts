import { defineConfig } from "@playwright/test";

const candidateRoot = process.env.CANDIDATE_APP_ROOT;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR;
if (candidateRoot !== "/candidate/app") {
  throw new Error("trusted Playwright control requires CANDIDATE_APP_ROOT=/candidate/app");
}
if (outputDir !== "/tmp/test-results") {
  throw new Error("trusted Playwright control requires its container-private results directory");
}

export default defineConfig({
  testDir: `${candidateRoot}/test/e2e`,
  outputDir,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
  },
});
