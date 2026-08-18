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

/**
 * Serve the rolling-window endpoints from fixed page and file maps.
 *
 * Shared because three cases need the same shape and a copy per case is how
 * they drift: a fixture that answers `/pulls` one way and `/pulls/N/files`
 * another stops testing the thing it was written for.
 *
 * `onPullsPage` observes which page numbers were requested, which is how the
 * stop-condition cases tell "the scan ended here" from "the scan ran again" —
 * the evaluation deliberately re-scans to detect a window that moved.
 */
function rollingWindowRequestPage(
  pulls: Record<number, unknown[]>,
  files: Record<number, unknown[]>,
  onPullsPage?: (page: number) => void,
) {
  return (endpoint: string, parameters: { page?: number }) => {
    if (endpoint === "repos/owner/repo/pulls") {
      onPullsPage?.(parameters.page as number);
      return pulls[parameters.page as number] ?? [];
    }
    const match = endpoint.match(/^repos\/owner\/repo\/pulls\/(\d+)(\/files)?$/);
    if (!match) throw new Error("unexpected-endpoint");
    const number = Number(match[1]);
    return match[2] ? files[number]! : { changed_files: files[number]!.length };
  };
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

    const requestPage = rollingWindowRequestPage(pulls, files);

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

    // A page whose entries are NOT descending is accepted. `updated_at` is a
    // mutable sort key, so a pull touched while the scan paginates moves and
    // an item can arrive out of sequence. Refusing that made an ordinary merge
    // landing mid-scan fail CI, and it protected nothing: `updated_at >=
    // merged_at` always, so reading until the window is exhausted cannot skip
    // a pull whose `merged_at` is inside it, whatever order the pages arrive
    // in. This case used to expect `pull-request-order-invalid`.
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
    ).not.toThrow("pull-request-order-invalid");

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

  it("still finds every in-window pull when a page arrives out of order", () => {
    // The shape observed on the real repository: one break, exactly at a page
    // boundary, zero duplicates — a pull touched while the scan paginated, so
    // page 2 opens with a NEWER timestamp than page 1 closed with.
    //
    // Refusing that is what used to fail. Accepting it only helps if the scan
    // is still complete, which is the property this pins: the sensitive pull
    // sitting AFTER the out-of-order entry must still be counted.
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T05:00:00Z", updated_at: "2026-07-12T06:00:00Z" },
      ],
      2: [
        // Out of order: newer than page 1's tail, because it was just updated.
        { number: 3, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T11:00:00Z" },
        { number: 4, merged_at: "2026-07-12T04:00:00Z", updated_at: "2026-07-12T05:00:00Z" },
      ],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive, 3: sensitive, 4: sensitive };

    const requestPage = rollingWindowRequestPage(pulls, files);

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 4,
        requestPage,
        pageSize: 2,
      }),
    ).toEqual({ count: 4, hit: true });
  });

  it("stops on the page's OLDEST entry, not on its last one", () => {
    // Those differ exactly when the order broke. Keying the stop on the last
    // entry would end the scan while an in-window pull was still unread on the
    // next page — the completeness bug that swapping the assertion for a
    // minimum is there to avoid.
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        // Older than the window: the page has reached past it.
        { number: 2, merged_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T01:00:00Z" },
        // …but the LAST entry is inside it, so a last-entry stop would page on.
        { number: 3, merged_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T09:00:00Z" },
      ],
      2: [{ number: 4, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" }],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive, 3: sensitive, 4: sensitive };
    // Page NUMBERS, not request count: the evaluation runs the scan twice — the
    // second pass re-derives the candidates and fails the run if the window
    // moved underneath it — so counting requests would count that revalidation.
    const requestedPages = new Set<number>();

    const requestPage = rollingWindowRequestPage(pulls, files, (page) =>
      requestedPages.add(page),
    );

    evaluateSensitiveRollingWindow({
      repo: REPO,
      since: "2026-07-01T00:00:00Z",
      threshold: 99,
      requestPage,
      pageSize: 3,
    });

    // Only page 1: its oldest entry is outside the window, so there is nothing
    // left to find however the entries were ordered within it.
    expect([...requestedPages]).toEqual([1]);
  });
});
