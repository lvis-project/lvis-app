import { defineConfig } from "vitest/config";

const candidateRoot = process.env.CANDIDATE_APP_ROOT;
if (candidateRoot !== "/candidate/app") {
  throw new Error("trusted Vitest control requires CANDIDATE_APP_ROOT=/candidate/app");
}

export default defineConfig({
  root: candidateRoot,
  test: {
    environment: "node",
    globals: false,
    hookTimeout: 45_000,
    testTimeout: 180_000,
    maxWorkers: 1,
    minWorkers: 1,
    include: [],
  },
});
