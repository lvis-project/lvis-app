/**
 * Permission SOT V2 — PermissionManager.checkPathScope.
 *
 * Pure unit coverage of the Layer 0 (sensitive-path hard-block) + Layer 1
 * (allowed-directories) path-scope predicate that P1-d moved out of
 * `src/tools/executor.ts` into the PermissionManager SOT. The move is
 * behavior-neutral: these cases pin the EXACT predicate the executor evaluated
 * inline before the move (first sensitive target wins for Layer 0; first
 * out-of-allowed target wins for Layer 1), so they double as the
 * behavior-neutrality proof.
 *
 * The method is a pure static predicate over ALREADY-canonicalized paths
 * (frozen-canonical contract): it does no realpath I/O. Tests build canonical
 * inputs with the same `caseFoldForMatch(canonicalizePathForMatch(...))` the
 * executor uses.
 */
import { describe, it, expect } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../sensitive-paths.js";

function fold(raw: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(raw));
}

function target(raw: string): { filePath: string; canonicalPath: string } {
  return { filePath: raw, canonicalPath: fold(raw) };
}

describe("PermissionManager.checkPathScope", () => {
  const allowed = [fold("/Users/ken/work/proj")];

  describe("Layer 0 — sensitive-path hit", () => {
    it("flags a ~/.ssh key as sensitiveHit with its pattern", () => {
      const t = target("/Users/ken/.ssh/id_rsa");
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [t],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toEqual({
        filePath: "/Users/ken/.ssh/id_rsa",
        pattern: "**/.ssh/**",
      });
    });

    it("returns the FIRST sensitive target when several match", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [
          target("/Users/ken/work/proj/src/index.ts"),
          target("/Users/ken/.aws/credentials"),
          target("/Users/ken/.ssh/id_rsa"),
        ],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit?.filePath).toBe("/Users/ken/.aws/credentials");
    });
  });

  describe("Layer 1 — out-of-allowed", () => {
    it("flags a path outside the allowed directories as outOfAllowed", () => {
      const t = target("/var/tmp/random-area/file.txt");
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [t],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toBeNull();
      expect(res.outOfAllowed).toEqual({
        filePath: "/var/tmp/random-area/file.txt",
        canonicalPath: fold("/var/tmp/random-area/file.txt"),
      });
    });

    it("returns the FIRST out-of-allowed target when several are outside", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [
          target("/Users/ken/work/proj/a.ts"),
          target("/etc/hosts"),
          target("/opt/other/b.ts"),
        ],
        allowedDirectories: allowed,
      });
      expect(res.outOfAllowed?.filePath).toBe("/etc/hosts");
    });

    it("treats an empty allow-list as deny-by-default (first target out)", () => {
      const t = target("/Users/ken/work/proj/a.ts");
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [t],
        allowedDirectories: [],
      });
      expect(res.outOfAllowed?.filePath).toBe("/Users/ken/work/proj/a.ts");
    });
  });

  describe("clean — inside allowed, not sensitive", () => {
    it("returns both null for a child of an allowed dir", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/Users/ken/work/proj/src/index.ts")],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toBeNull();
      expect(res.outOfAllowed).toBeNull();
    });

    it("returns both null for an empty target list", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toBeNull();
      expect(res.outOfAllowed).toBeNull();
    });
  });

  describe("combined — sensitive AND out-of-allowed", () => {
    it("reports both hits independently (executor consumes sensitiveHit first)", () => {
      // A ~/.ssh key that is also outside the allowed dirs: Layer 0 and Layer 1
      // both fire in the predicate; the executor's layer-0 deny returns before
      // it ever consults outOfAllowed, but the predicate stays honest.
      const t = target("/Users/ken/.ssh/id_rsa");
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [t],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit?.pattern).toBe("**/.ssh/**");
      expect(res.outOfAllowed?.filePath).toBe("/Users/ken/.ssh/id_rsa");
    });
  });
});
