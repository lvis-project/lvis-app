import { describe, expect, it } from "vitest";
import {
  createGhApiRequester,
  evaluateClusterScope,
  evaluateSensitiveRollingWindow,
  isCommentOnlyPatch,
  pathsFromFileRecords,
  pullRequestHasSensitiveCommitBundle,
  pullRequestTouchesSensitiveFiles,
} from "../../scripts/check-cluster-scope.mjs";

const REPO = "owner/repo";

function sha(character: string): string {
  return character.repeat(40);
}

describe("cluster scope API evaluation", () => {
  it("includes previous filenames so sensitive renames remain fail-closed", () => {
    expect(
      pathsFromFileRecords([
        {
          status: "renamed",
          filename: "src/ipc/__tests__/domain.test.ts",
          previous_filename: "src/ipc/domain.ts",
        },
      ]),
    ).toEqual(["src/ipc/__tests__/domain.test.ts", "src/ipc/domain.ts"]);
  });

  it("classifies paginated mixed production and test files with one helper", () => {
    const requestPage = (_endpoint: string, parameters: { page: number }) =>
      parameters.page === 1
        ? [
            { status: "modified", filename: "src/ipc/__tests__/domain.test.ts" },
            { status: "modified", filename: "src/ui/view.tsx" },
          ]
        : [{ status: "modified", filename: "src/ipc/domain.ts" }];

    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage,
        pageSize: 2,
      }),
    ).toBe(true);
  });

  it("fails closed for incomplete and saturated file pagination", () => {
    const incomplete = () => [{ status: "modified", filename: "src/ui/view.tsx" }];
    expect(() =>
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage: incomplete,
        pageSize: 2,
      }),
    ).toThrow("pull-request-files-incomplete");

    const saturated = () => [
      { status: "modified", filename: "src/ui/one.tsx" },
      { status: "modified", filename: "src/ui/two.tsx" },
    ];
    expect(() =>
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage: saturated,
        pageSize: 2,
        maxFiles: 2,
      }),
    ).toThrow("pull-request-files-saturated");
  });

  it("counts three mixed sensitive commits as a bundle", () => {
    const commits = [sha("1"), sha("2"), sha("3")];
    const requestPage = (endpoint: string) => {
      if (endpoint.endsWith("/commits")) {
        return commits.map((commit) => ({ sha: commit }));
      }
      return {
        files: [
          { status: "modified", filename: "src/audit/__tests__/writer.test.ts" },
          { status: "modified", filename: "src/audit/writer.ts" },
        ],
      };
    };

    expect(
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 3,
        threshold: 3,
        requestPage,
      }),
    ).toBe(true);
  });

  it("paginates the rolling window and distinguishes test-only, mixed, and rename records", () => {
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T09:00:00Z" },
      ],
      2: [
        { number: 3, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
        { number: 4, merged_at: "2026-07-12T06:00:00Z", updated_at: "2026-07-12T07:00:00Z" },
      ],
    };
    const files = {
      1: [{ status: "modified", filename: "src/ipc/__tests__/only.test.ts" }],
      2: [
        { status: "modified", filename: "src/ipc/__tests__/mixed.test.ts" },
        { status: "modified", filename: "src/ipc/domain.ts" },
      ],
      3: [
        {
          status: "renamed",
          filename: "src/ipc/__tests__/renamed.test.ts",
          previous_filename: "src/ipc/renamed.ts",
        },
      ],
      4: [{ status: "modified", filename: "src/boot/start.ts" }],
    };

    const requestPage = (endpoint: string, parameters: { page?: number }) => {
      if (endpoint === "repos/owner/repo/pulls") {
        return pulls[parameters.page as keyof typeof pulls] ?? [];
      }
      const match = endpoint.match(/^repos\/owner\/repo\/pulls\/(\d+)(\/files)?$/);
      if (!match) throw new Error("unexpected-endpoint");
      const number = Number(match[1]) as keyof typeof files;
      return match[2] ? files[number] : { changed_files: files[number].length };
    };

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        requestPage,
        pageSize: 2,
      }),
    ).toEqual({ count: 3, hit: true });
  });

  it("returns a bundle violation from the integrated current-PR scope", () => {
    const commits = [sha("4"), sha("5"), sha("6")];
    const requestPage = (endpoint: string) => {
      if (endpoint.endsWith("/pulls/9/files")) {
        return [
          { status: "modified", filename: "src/sandbox/__tests__/policy.test.ts" },
          { status: "modified", filename: "src/sandbox/policy.ts" },
        ];
      }
      if (endpoint.endsWith("/pulls/9/commits")) {
        return commits.map((commit) => ({ sha: commit }));
      }
      if (endpoint.includes("/commits/")) {
        return { files: [{ status: "modified", filename: "src/core/permissions/gate.ts" }] };
      }
      throw new Error("unexpected-endpoint");
    };

    expect(
      evaluateClusterScope({
        snapshot: { number: 9, changed_files: 2, commits: 3 },
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        requestPage,
      }),
    ).toEqual({
      bundle: true,
      reason: "bundle",
      sensitive: true,
      violation: true,
      window: false,
      windowCount: 0,
    });
  });

  it("stops after the current PR is proven non-sensitive", () => {
    let calls = 0;
    const result = evaluateClusterScope({
      snapshot: { number: 10, changed_files: 1, commits: 1 },
      repo: REPO,
      since: "2026-07-01T00:00:00Z",
      threshold: 3,
      requestPage: () => {
        calls += 1;
        return [{ status: "modified", filename: "src/ui/view.tsx" }];
      },
    });
    expect(result).toEqual({
      bundle: false,
      reason: "",
      sensitive: false,
      violation: false,
      window: false,
      windowCount: 0,
    });
    expect(calls).toBe(1);
  });
  it("rejects missing, unknown, or incomplete rename status metadata", () => {
    expect(() =>
      pathsFromFileRecords([
        {
          filename: "src/ipc/__tests__/renamed.test.ts",
          status: "renamed",
        },
      ]),
    ).toThrow("github-previous-filename-required");
    expect(() =>
      pathsFromFileRecords([{ filename: "src/ui/view.tsx" }]),
    ).toThrow("github-file-record-invalid");
    expect(() =>
      pathsFromFileRecords([
        { filename: "src/ui/view.tsx", status: "unexpected" },
      ]),
    ).toThrow("github-file-record-invalid");
  });

  it("rejects duplicate, reordered, saturated, or changing rolling-window pages", () => {
    const pull = (number: number, updatedAt: string) => ({
      merged_at: "2026-07-12T00:00:00Z",
      number,
      updated_at: updatedAt,
    });

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        pageSize: 2,
        requestPage: (endpoint: string, parameters: { page: number }) => {
          if (endpoint !== "repos/owner/repo/pulls") throw new Error("unexpected-endpoint");
          return parameters.page === 1
            ? [pull(1, "2026-07-12T04:00:00Z"), pull(2, "2026-07-12T03:00:00Z")]
            : [pull(2, "2026-07-12T03:00:00Z"), pull(3, "2026-07-12T02:00:00Z")];
        },
      }),
    ).toThrow("pull-request-page-duplicate");

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        pageSize: 2,
        maxPullPages: 1,
        requestPage: () => [
          pull(1, "2026-07-12T04:00:00Z"),
          pull(2, "2026-07-12T03:00:00Z"),
        ],
      }),
    ).toThrow("pull-request-pages-saturated");

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        pageSize: 2,
        requestPage: () => [
          pull(1, "2026-07-12T03:00:00Z"),
          pull(2, "2026-07-12T04:00:00Z"),
        ],
      }),
    ).toThrow("pull-request-order-invalid");

    let listCalls = 0;
    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 2,
        pageSize: 2,
        requestPage: (endpoint: string) => {
          if (endpoint === "repos/owner/repo/pulls") {
            listCalls += 1;
            return [
              listCalls === 1
                ? pull(1, "2026-07-12T04:00:00Z")
                : pull(2, "2026-07-12T04:00:00Z"),
            ];
          }
          if (endpoint.endsWith("/pulls/1")) return { changed_files: 1 };
          if (endpoint.endsWith("/pulls/1/files")) {
            return [{ filename: "src/ui/view.tsx", status: "modified" }];
          }
          throw new Error("unexpected-endpoint");
        },
      }),
    ).toThrow("pull-request-window-changed");
  });

  it("fails closed for incomplete, overflowed, and saturated commit pagination", () => {
    const first = sha("7");
    const second = sha("8");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 1,
        requestPage: () => [],
      }),
    ).toThrow("pull-request-commits-incomplete");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 2,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }, { sha: second }]
            : { files: [] },
      }),
    ).toThrow("pull-request-commits-overflow");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 3,
        threshold: 3,
        pageSize: 2,
        maxCommits: 2,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }, { sha: second }]
            : { files: [] },
      }),
    ).toThrow("pull-request-commits-saturated");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 1,
        pageSize: 1,
        maxFiles: 1,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }]
            : {
                files: [
                  { filename: "src/ui/view.tsx", status: "modified" },
                ],
              },
      }),
    ).toThrow("commit-files-saturated");
  });

  it("builds gh API requests without a shell and rejects command or JSON failures", () => {
    let captured:
      | { command: string; args: string[]; options: { maxBuffer: number } }
      | undefined;
    const request = createGhApiRequester((command, args, options) => {
      captured = { command, args, options };
      return { status: 0, stdout: "[]" };
    });
    expect(request("repos/owner/repo/pulls", { page: 2, per_page: 100 })).toEqual([]);
    expect(captured?.command).toBe("gh");
    expect(captured?.args).toEqual([
      "api",
      "--method",
      "GET",
      "repos/owner/repo/pulls",
      "-f",
      "page=2",
      "-f",
      "per_page=100",
    ]);
    expect(captured?.options.maxBuffer).toBe(10 * 1024 * 1024);

    expect(() =>
      createGhApiRequester(() => ({ status: 1, stdout: "" }))("endpoint", {}),
    ).toThrow("github-api-request-failed");
    expect(() =>
      createGhApiRequester(() => ({ status: 0, stdout: "not-json" }))(
        "endpoint",
        {},
      ),
    ).toThrow("github-api-response-invalid");
  });
});

describe("comment-only exclusion from sensitive-cluster detection", () => {
  const COMMENT_PATCH =
    "@@ -1,2 +1,2 @@\n-  // old comment\n+  // new comment\n   const x = 1;\n";
  const JSDOC_PATCH = "@@ -1 +1 @@\n-   * old jsdoc\n+   * new jsdoc\n";
  const CODE_PATCH = "@@ -1 +1 @@\n-  const x = 1;\n+  const x = 2;\n";

  it("recognizes comment/JSDoc/blank-only patches and rejects code or missing patches", () => {
    expect(isCommentOnlyPatch(COMMENT_PATCH)).toBe(true);
    expect(isCommentOnlyPatch(JSDOC_PATCH)).toBe(true);
    expect(isCommentOnlyPatch("@@ -1 +1 @@\n-\n+\n+  // added\n")).toBe(true);
    expect(isCommentOnlyPatch(CODE_PATCH)).toBe(false);
    expect(
      isCommentOnlyPatch("@@ -1 +1 @@\n+  const x = 1; // trailing comment\n"),
    ).toBe(false);
    expect(isCommentOnlyPatch(undefined)).toBe(false);
    expect(isCommentOnlyPatch("")).toBe(false);
  });

  it("does NOT flag a sensitive file whose change is comment-only", () => {
    const requestPage = () => [
      { status: "modified", filename: "src/boot/steps/x.ts", patch: COMMENT_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage,
      }),
    ).toBe(false);
  });

  it("still flags a real code change, and a sensitive file with no patch (conservative)", () => {
    const codeChange = () => [
      { status: "modified", filename: "src/boot/steps/x.ts", patch: CODE_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage: codeChange,
      }),
    ).toBe(true);

    const noPatch = () => [
      { status: "modified", filename: "src/permissions/x.ts" },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage: noPatch,
      }),
    ).toBe(true);
  });

  it("flags when a comment-only sensitive file is mixed with a code-change sensitive file", () => {
    const requestPage = () => [
      { status: "modified", filename: "src/boot/a.ts", patch: COMMENT_PATCH },
      { status: "modified", filename: "src/permissions/b.ts", patch: CODE_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 2,
        requestPage,
      }),
    ).toBe(true);
  });
});
