import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import {
  groupSessionsByProject,
  pathBasename,
  projectLabelForSession,
} from "../insights-project-groups.js";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s",
    modifiedAt: "2026-07-04T00:00:00.000Z",
    title: "대화",
    sessionKind: "main",
    ...overrides,
  };
}

describe("insights project group-by", () => {
  it("groups default-project conversations under their project, not the fallback", () => {
    // Regression: the default/base-directory project carries a projectRoot (and
    // now a persisted projectName). Both of its conversations must land in one
    // named group — never the "프로젝트 없음" fallback bucket.
    const sessions: SessionSummary[] = [
      session({ id: "a", projectRoot: "C:\\Users\\ikcha\\.lvis\\workspace", projectName: "default", modifiedAt: "2026-07-04T02:00:00.000Z" }),
      session({ id: "b", projectRoot: "C:\\Users\\ikcha\\.lvis\\workspace", projectName: "default", modifiedAt: "2026-07-04T01:00:00.000Z" }),
    ];

    const groups = groupSessionsByProject(sessions, "프로젝트 없음");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("default");
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(groups.some((g) => g.name === "프로젝트 없음")).toBe(false);
  });

  it("falls back to the basename of projectRoot when projectName is absent", () => {
    const sessions: SessionSummary[] = [
      session({ id: "a", projectRoot: "C:\\work\\alpha" }),
    ];

    const groups = groupSessionsByProject(sessions, "프로젝트 없음");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("alpha");
  });

  it("only uses the fallback label for sessions with no project identity at all", () => {
    const sessions: SessionSummary[] = [
      session({ id: "named", projectName: "beta" }),
      session({ id: "orphan" }),
    ];

    const groups = groupSessionsByProject(sessions, "프로젝트 없음");
    const byName = new Map(groups.map((g) => [g.name, g]));

    expect(byName.get("beta")?.sessions.map((s) => s.id)).toEqual(["named"]);
    expect(byName.get("프로젝트 없음")?.sessions.map((s) => s.id)).toEqual(["orphan"]);
  });

  it("orders groups by their most-recent conversation and sorts within a group", () => {
    const sessions: SessionSummary[] = [
      session({ id: "old-alpha", projectName: "alpha", modifiedAt: "2026-07-04T01:00:00.000Z" }),
      session({ id: "new-beta", projectName: "beta", modifiedAt: "2026-07-04T05:00:00.000Z" }),
      session({ id: "mid-alpha", projectName: "alpha", modifiedAt: "2026-07-04T03:00:00.000Z" }),
    ];

    const groups = groupSessionsByProject(sessions, "프로젝트 없음");

    expect(groups.map((g) => g.name)).toEqual(["beta", "alpha"]);
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(["mid-alpha", "old-alpha"]);
  });

  it("projectLabelForSession + pathBasename helpers behave", () => {
    expect(pathBasename("C:\\a\\b\\c")).toBe("c");
    expect(pathBasename("/home/user/proj/")).toBe("proj");
    expect(pathBasename("  ")).toBeUndefined();
    expect(projectLabelForSession(session({ projectName: "  named  " }))).toBe("named");
    expect(projectLabelForSession(session({ projectRoot: "/x/y/zeta" }))).toBe("zeta");
    expect(projectLabelForSession(session({}))).toBeUndefined();
  });

  it("uses the current canonical project label and keeps unscoped sessions in the fallback bucket", () => {
    const projects = [
      { projectRoot: "C:\\workspace", projectName: "workspace", isDefault: true },
      { projectRoot: "C:\\work\\team-a\\shared", projectName: "shared — team-a" },
      { projectRoot: "C:\\work\\team-b\\shared", projectName: "shared — team-b" },
    ];
    const scoped = session({
      id: "scoped",
      projectRoot: "c:/work/team-a/shared/",
      projectName: "shared",
    });
    const general = session({ id: "general", projectName: "stale-name" });

    expect(projectLabelForSession(scoped, projects)).toBe("shared — team-a");
    expect(projectLabelForSession(general, projects)).toBeUndefined();
    expect(
      groupSessionsByProject([scoped, general], "일반 대화", projects).map((group) => group.name),
    ).toEqual([
      "shared — team-a",
      "일반 대화",
    ]);
  });
});
