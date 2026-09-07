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
import { foldPathForMatch as fold } from "./test-helpers.js";

function target(raw: string): { filePath: string; canonicalPath: string } {
  return { filePath: raw, canonicalPath: fold(raw) };
}

/**
 * The pre-asymmetry call shape — every effect confined to the directory list.
 *
 * The cases below it pin the WRITE half of the effect matrix, which is exactly
 * the behaviour the read/write split did NOT change: a write is still refused
 * outside the authorized directories. The read half is its own describe block.
 */
function checkWrite(args: {
  canonicalTargets: readonly { filePath: string; canonicalPath: string }[];
  allowedDirectories: readonly string[];
}): ReturnType<typeof PermissionManager.checkPathScope> {
  return PermissionManager.checkPathScope({
    ...args,
    effect: "write",
    blockReadsOutsideWorkingDirectories: false,
  });
}

describe("PermissionManager.checkPathScope", () => {
  const allowed = [fold("/Users/example/work/proj")];

  describe("Layer 0 — sensitive-path hit", () => {
    it("flags a ~/.ssh key as sensitiveHit with its pattern", () => {
      const t = target("/Users/example/.ssh/id_rsa");
      const res = checkWrite({
        canonicalTargets: [t],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toEqual({
        filePath: "/Users/example/.ssh/id_rsa",
        pattern: "**/.ssh/**",
      });
    });

    it("returns the FIRST sensitive target when several match", () => {
      const res = checkWrite({
        canonicalTargets: [
          target("/Users/example/work/proj/src/index.ts"),
          target("/Users/example/.aws/credentials"),
          target("/Users/example/.ssh/id_rsa"),
        ],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit?.filePath).toBe("/Users/example/.aws/credentials");
    });
  });

  describe("Layer 1 — out-of-allowed", () => {
    it("flags a path outside the allowed directories as outOfAllowed", () => {
      const t = target("/var/tmp/random-area/file.txt");
      const res = checkWrite({
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
      const res = checkWrite({
        canonicalTargets: [
          target("/Users/example/work/proj/a.ts"),
          target("/etc/hosts"),
          target("/opt/other/b.ts"),
        ],
        allowedDirectories: allowed,
      });
      expect(res.outOfAllowed?.filePath).toBe("/etc/hosts");
    });

    it("treats an empty allow-list as deny-by-default (first target out)", () => {
      const t = target("/Users/example/work/proj/a.ts");
      const res = checkWrite({
        canonicalTargets: [t],
        allowedDirectories: [],
      });
      expect(res.outOfAllowed?.filePath).toBe("/Users/example/work/proj/a.ts");
    });
  });

  describe("clean — inside allowed, not sensitive", () => {
    it("returns both null for a child of an allowed dir", () => {
      const res = checkWrite({
        canonicalTargets: [target("/Users/example/work/proj/src/index.ts")],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit).toBeNull();
      expect(res.outOfAllowed).toBeNull();
    });

    it("returns both null for an empty target list", () => {
      const res = checkWrite({
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
      const t = target("/Users/example/.ssh/id_rsa");
      const res = checkWrite({
        canonicalTargets: [t],
        allowedDirectories: allowed,
      });
      expect(res.sensitiveHit?.pattern).toBe("**/.ssh/**");
      expect(res.outOfAllowed?.filePath).toBe("/Users/example/.ssh/id_rsa");
    });
  });

  // ── Effect matrix — reads are wide, writes stay confined ──────────────
  //
  // A directory list answers "what may this agent CHANGE". Answering "what may
  // it LOOK AT" with the same list is what refused `ls /` on a machine the user
  // had already handed over, so the predicate now takes the effect the operand
  // carries and only confines a write.
  describe("effect matrix", () => {
    const outside = target("/var/tmp/random-area/file.txt");
    const inside = target("/Users/example/work/proj/src/index.ts");

    const check = (
      effect: "read" | "write",
      blockReadsOutsideWorkingDirectories: boolean,
      t = outside,
    ): ReturnType<typeof PermissionManager.checkPathScope> =>
      PermissionManager.checkPathScope({
        canonicalTargets: [t],
        allowedDirectories: allowed,
        effect,
        blockReadsOutsideWorkingDirectories,
      });

    it("admits a read outside the allowed directories", () => {
      expect(check("read", false).outOfAllowed).toBeNull();
    });

    it("refuses a write outside the allowed directories", () => {
      expect(check("write", false).outOfAllowed?.filePath).toBe(outside.filePath);
    });

    it("refuses a read outside when the user re-fenced reads", () => {
      expect(check("read", true).outOfAllowed?.filePath).toBe(outside.filePath);
    });

    it("still confines a write when reads are re-fenced", () => {
      expect(check("write", true).outOfAllowed?.filePath).toBe(outside.filePath);
    });

    it("admits both effects inside the allowed directories", () => {
      expect(check("read", false, inside).outOfAllowed).toBeNull();
      expect(check("write", false, inside).outOfAllowed).toBeNull();
    });

    // Layer 0 runs before the effect is consulted and is not part of the
    // asymmetry: widening reads widened the DIRECTORY boundary, not the
    // deny-list, and a protected path stays unreadable either way.
    it("keeps the Layer 0 deny for a read of a sensitive path", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/Users/example/.ssh/id_rsa")],
        allowedDirectories: allowed,
        effect: "read",
        blockReadsOutsideWorkingDirectories: false,
      });
      expect(res.sensitiveHit?.pattern).toBe("**/.ssh/**");
    });
  });

  // The admission a wide read produces leaves no dialog and no grant behind it,
  // so `readOutsideScope` is the only thing the audit row can be built from.
  describe("readOutsideScope — the auditable admission", () => {
    it("names the read the directory list would have refused", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/var/tmp/random-area/file.txt")],
        allowedDirectories: allowed,
        effect: "read",
        blockReadsOutsideWorkingDirectories: false,
      });
      expect(res.readOutsideScope?.filePath).toBe("/var/tmp/random-area/file.txt");
    });

    it("is null for a read that was inside the allowed directories anyway", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/Users/example/work/proj/src/index.ts")],
        allowedDirectories: allowed,
        effect: "read",
        blockReadsOutsideWorkingDirectories: false,
      });
      expect(res.readOutsideScope).toBeNull();
    });

    it("is null for a write — a write outside is refused, never admitted", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/var/tmp/random-area/file.txt")],
        allowedDirectories: allowed,
        effect: "write",
        blockReadsOutsideWorkingDirectories: false,
      });
      expect(res.readOutsideScope).toBeNull();
      expect(res.outOfAllowed).not.toBeNull();
    });

    it("is null when reads are re-fenced — the target lands in outOfAllowed", () => {
      const res = PermissionManager.checkPathScope({
        canonicalTargets: [target("/var/tmp/random-area/file.txt")],
        allowedDirectories: allowed,
        effect: "read",
        blockReadsOutsideWorkingDirectories: true,
      });
      expect(res.readOutsideScope).toBeNull();
      expect(res.outOfAllowed?.filePath).toBe("/var/tmp/random-area/file.txt");
    });
  });
});
