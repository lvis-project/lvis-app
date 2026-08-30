import { describe, expect, it, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { extractTargetFilePaths } from "../pipeline/path-extraction.js";
import { DeleteFileTool, EditFileTool, WriteFileTool } from "../file-tools.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { setProcessPlatform as setPlatform } from "../../__tests__/test-helpers.js";

/**
 * The capability under test is AGREEMENT, so nothing here asserts on a helper
 * in isolation. Each case drives BOTH sides from the SAME real producers:
 *
 *   PERMISSION side — `extractTargetFilePaths(tool, input, cwd)`, the exact
 *     call `invocation-runner.ts` makes before canonicalizing and handing the
 *     result to `PermissionManager.checkPathScope`. It reads `tool.pathFields`
 *     off the real tool instance, so a tool that stopped declaring `path`
 *     would show up here as an empty extraction, not a passing test.
 *
 *   TOOL side — `tool.approvalCacheKey(input, ctx)`, the public method that
 *     runs `FileTool.resolveApprovalPath` — the same expansion+resolve pair as
 *     `FileTool.resolvePath`, which produces the path actually opened, and the
 *     string baked into the persisted grant.
 *
 * Both are fed one shared `input` object, so there is no hand-built fixture
 * setting the two sides independently.
 */

const CWD = pathResolve(process.cwd());

type PathTool = WriteFileTool | EditFileTool | DeleteFileTool;

function permissionTarget(tool: PathTool, input: object): string | undefined {
  return extractTargetFilePaths(tool, input, CWD)[0];
}

function toolTarget(tool: PathTool, input: object): string {
  return tool.approvalCacheKey(input, { cwd: CWD }).replace(/^path:/, "");
}

const realPlatform = process.platform;
afterEach(() => setPlatform(realPlatform));

describe("tilde expansion — the permission target and the tool target are one string", () => {
  // These three expose `approvalCacheKey`, which is the public read-out of
  // `FileTool.resolveApprovalPath`. `read_file` inherits the same
  // `FileTool.resolvePath` expansion but declares no approval key, so it is
  // covered transitively by the shared base method rather than duplicated here.
  for (const [label, tool] of [
    ["write_file", new WriteFileTool()],
    ["edit_file", new EditFileTool()],
    ["delete_file", new DeleteFileTool()],
  ] as [string, PathTool][]) {
    describe(label, () => {
      it("declares a `path` field, so the permission extraction is not vacuous", () => {
        expect(tool.pathFields).toContain("path");
        expect(permissionTarget(tool, { path: "~/Documents/x" })).toBeDefined();
      });

      it("agrees on bare `~`", () => {
        const input = { path: "~" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(homedir()));
      });

      it("agrees on `~/` (separator on every platform)", () => {
        const input = { path: "~/Documents/x" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(homedir(), "Documents/x"));
      });

      it("agrees on `~\\` — the regression this consolidation closes", () => {
        const input = { path: "~\\Documents\\x" };
        // Before consolidation these differed on win32: PERM expanded to
        // <home>\Documents\x while the tool opened <cwd>\~\Documents\x.
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
      });

      it("agrees on `~\\.ssh\\id_rsa` — a sensitive-table target", () => {
        const input = { path: "~\\.ssh\\id_rsa" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
      });

      it("agrees on a non-tilde relative path (no behaviour change)", () => {
        const input = { path: "src/index.ts" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(CWD, "src/index.ts"));
      });

      // The two sides must agree on BOTH platforms, not just the one CI runs
      // on. Without these cases a re-introduced private expander on either
      // side that is unconditional about `~\` would still look green here,
      // because win32 expands `~\` on both sides.
      for (const platform of ["win32", "linux"] as const) {
        it(`agrees on \`~\\\` with platform=${platform}`, () => {
          setPlatform(platform);
          const input = { path: "~\\Documents\\x" };
          expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        });

        it(`agrees on \`~/\` with platform=${platform}`, () => {
          setPlatform(platform);
          const input = { path: "~/Documents/x" };
          expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        });
      }

      it("agrees on a literal `~` that is not a home reference", () => {
        const input = { path: "~notahome/x" };
        expect(permissionTarget(tool, input)).toBe(toolTarget(tool, input));
        expect(toolTarget(tool, input)).toBe(pathResolve(CWD, "~notahome/x"));
      });
    });
  }
});

describe("expandLeadingTilde — `~\\` is guarded on the platform that owns the separator", () => {
  it("expands `~\\` on win32, where `\\` IS a path separator", () => {
    setPlatform("win32");
    expect(expandLeadingTilde("~\\Documents\\x")).toBe(
      pathResolve(homedir(), "Documents\\x"),
    );
  });

  it("leaves `~\\` alone on POSIX, where `\\` is an ordinary filename character", () => {
    setPlatform("linux");
    // `~\Documents\x` names ONE file called `~\Documents\x` in the cwd. The
    // pre-consolidation permission-side copy expanded it unconditionally and
    // therefore judged $HOME/Documents/x — a file the tool never opens.
    expect(expandLeadingTilde("~\\Documents\\x")).toBe("~\\Documents\\x");
  });

  it("expands `~` and `~/` on BOTH platforms", () => {
    for (const platform of ["win32", "linux"] as const) {
      setPlatform(platform);
      expect(expandLeadingTilde("~")).toBe(homedir());
      expect(expandLeadingTilde("~/a/b")).toBe(pathResolve(homedir(), "a/b"));
    }
  });

  it("does not touch `~user` style or a bare relative path", () => {
    for (const platform of ["win32", "linux"] as const) {
      setPlatform(platform);
      expect(expandLeadingTilde("~root/x")).toBe("~root/x");
      expect(expandLeadingTilde("src/a.ts")).toBe("src/a.ts");
    }
  });
});
