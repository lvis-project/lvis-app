import { describe, expect, it, vi } from "vitest";

import {
  createVitestRuns,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SHARD_COUNT,
  runTests,
} from "../../scripts/run-tests.mjs";

describe("run-tests", () => {
  it("splits the complete suite into deterministic sequential shards", () => {
    expect(createVitestRuns([])).toEqual(
      Array.from({ length: DEFAULT_SHARD_COUNT }, (_, index) => [
        "run",
        `--shard=${index + 1}/${DEFAULT_SHARD_COUNT}`,
        `--maxWorkers=${DEFAULT_MAX_WORKERS}`,
        "--no-file-parallelism",
      ]),
    );
  });

  it("runs an explicit target once without adding a shard", () => {
    expect(createVitestRuns(["test/example.test.ts", "--reporter=verbose"])).toEqual([
      ["run", "test/example.test.ts", "--reporter=verbose"],
    ]);
  });

  it("runs every shard and reports the first ordinary failure", async () => {
    const runVitest = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, signal: null })
      .mockResolvedValueOnce({ code: 1, signal: null })
      .mockResolvedValueOnce({ code: 2, signal: null });

    await expect(
      runTests([], { shardCount: 3, maxWorkers: 2, runVitest, log: vi.fn() }),
    ).resolves.toEqual({ code: 1, signal: null });
    expect(runVitest.mock.calls).toEqual([
      [["run", "--shard=1/3", "--maxWorkers=2", "--no-file-parallelism"]],
      [["run", "--shard=2/3", "--maxWorkers=2", "--no-file-parallelism"]],
      [["run", "--shard=3/3", "--maxWorkers=2", "--no-file-parallelism"]],
    ]);
  });

  it("stops immediately when a shard is terminated by a signal", async () => {
    const runVitest = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, signal: null })
      .mockResolvedValueOnce({ code: null, signal: "SIGTERM" });

    await expect(
      runTests([], { shardCount: 3, runVitest, log: vi.fn() }),
    ).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(runVitest).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid arguments, shard counts, and worker counts", () => {
    expect(() => createVitestRuns([1] as unknown as string[])).toThrow(
      "[test-args-invalid]",
    );
    expect(() => createVitestRuns([], 0)).toThrow("[test-shard-count-invalid]");
    expect(() => createVitestRuns([], 1, 0)).toThrow("[test-max-workers-invalid]");
  });
});
