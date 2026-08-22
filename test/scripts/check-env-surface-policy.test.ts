import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  evaluate,
  scanEnvReads,
  scanRendererSettingsPaths,
} from "../../scripts/check-env-surface-policy.js";
import { ENV_BACKED_SETTINGS } from "../../src/shared/env-backed-settings.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-env-surface-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): void {
  writeFileSync(join(dir, name), body, "utf-8");
}

describe("env-surface scan", () => {
  it("finds the read shapes the resolvers actually use", () => {
    write("a.ts", `
      const a = process.env.LVIS_DOTTED;
      const b = process.env["LVIS_INDEXED"];
      export function f(env: NodeJS.ProcessEnv) {
        return env.LVIS_PARAM === "1" || env['LVIS_PARAM_INDEXED'] === "1";
      }
    `);
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "b.tsx"), 'const c = process.env.LVIS_NESTED;\n', "utf-8");

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "LVIS_DOTTED",
      "LVIS_INDEXED",
      "LVIS_NESTED",
      "LVIS_PARAM",
      "LVIS_PARAM_INDEXED",
    ]);
  });

  it("ignores a name that is a constant rather than an environment read", () => {
    // The reason the scan is not a bare `LVIS_[A-Z_]+` grep: these are ordinary
    // exported constants, and demanding they be classified as configuration
    // would be asking the author for nonsense.
    write("c.ts", `
      export const LVIS_TOKEN_NAMES = ["a"];
      import { LVIS_LOGO_PATH } from "./logo.js";
      const label = "LVIS_NOT_AN_ENV_READ";
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("finds the names a table-driven resolver looks up through a key map", () => {
    // The shape that made the tailnet group invisible to the first version of
    // this gate: no variable name ever appears at the lookup site.
    write("table.ts", `
      const ENV_KEY = { enabled: "LVIS_TABLE_ONE", port: "LVIS_TABLE_TWO" };
      export function layer(env: NodeJS.ProcessEnv, key: "enabled" | "port") {
        return env[ENV_KEY[key]];
      }
    `);

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "LVIS_TABLE_ONE",
      "LVIS_TABLE_TWO",
    ]);
  });

  it("does not mistake a quoted prefix for a variable of that name", () => {
    // `LVIS_DEMO_` names a family the packaged-env scrub matches by prefix.
    // Demanding a control for it would be demanding one for nothing.
    write("scrub.ts", `
      const PREFIXES = ["LVIS_DEMO_"];
      export function scrub(env: NodeJS.ProcessEnv, name: string) {
        if (PREFIXES.some((p) => name.startsWith(p))) delete env[name];
      }
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("does not widen a test file, where a quoted name is a fixture it sets", () => {
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(
      join(dir, "__tests__", "d.test.ts"),
      `
        const NAMES = { fixture: "LVIS_FIXTURE" };
        const env: NodeJS.ProcessEnv = {};
        const v = env[NAMES.fixture];
      `,
      "utf-8",
    );

    expect(scanEnvReads(dir).size).toBe(0);
  });
});

describe("renderer settings-path scan", () => {
  it("finds both spellings a surface uses to name a path", () => {
    // The notice prop, and the row list of the one table-driven tab whose
    // notice is passed `settingsPath={row.path}`.
    write("Tab.tsx", `
      const ROWS = [{ path: "system.localApiServer", label: "x" }];
      export function Tab() {
        return <EnvForcedNotice settingsPath="system.corpCaEnabled" testId="t" />;
      }
    `);

    const paths = scanRendererSettingsPaths(dir);
    expect(paths.has("system.localApiServer")).toBe(true);
    expect(paths.has("system.corpCaEnabled")).toBe(true);
  });

  it("does not count a path quoted in a test", () => {
    // Otherwise a test for a control that was never built would satisfy the
    // gate — which is the one way this check could certify the thing it exists
    // to catch.
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(
      join(dir, "__tests__", "Tab.test.tsx"),
      'const forced = ["features.osToolSandbox"];\n',
      "utf-8",
    );

    expect(scanRendererSettingsPaths(dir).size).toBe(0);
  });
});

describe("env-surface policy", () => {
  const buckets = (over: Record<string, readonly string[]> = {}) =>
    ([
      ["development", over["development"] ?? []],
      ["internal", over["internal"] ?? []],
      ["settings", over["settings"] ?? []],
      ["pending", over["pending"] ?? []],
    ] as ReadonlyArray<readonly [string, readonly string[]]>);

  it("fails on a variable the source reads and nobody classified", () => {
    const failures = evaluate(new Map([["LVIS_NEW", "src/main/x.ts"]]), buckets(), [], 0);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("LVIS_NEW");
    // The message has to say what to do, or the next author lists it as pending
    // because that is the cheapest square to tick.
    expect(failures[0]).toContain("build the control");
  });

  it("fails when the unfinished list grows past its ceiling", () => {
    const pending = ["LVIS_A", "LVIS_B"];
    const found = new Map([["LVIS_A", "a.ts"], ["LVIS_B", "b.ts"]]);

    expect(evaluate(found, buckets({ pending }), pending, 2)).toEqual([]);
    expect(evaluate(found, buckets({ pending }), pending, 1)).toEqual([
      expect.stringContaining("ceiling 1"),
    ]);
  });

  it("fails when one variable is claimed by two buckets", () => {
    const found = new Map([["LVIS_X", "x.ts"]]);
    const failures = evaluate(
      found,
      buckets({ development: ["LVIS_X"], settings: ["LVIS_X"] }),
      [],
      0,
    );

    expect(failures).toEqual([expect.stringContaining('both "development" and "settings"')]);
  });

  it("fails on an entry nothing reads any more, so the lists cannot rot", () => {
    const failures = evaluate(new Map(), buckets({ pending: ["LVIS_GONE"] }), ["LVIS_GONE"], 5);

    expect(failures).toEqual([expect.stringContaining("nothing reads it any more")]);
  });

  it("fails on a registry entry no renderer surface names", () => {
    // The registry is what puts a variable in the "settings" bucket, so an
    // entry with no control would otherwise be a variable the gate certifies
    // as reachable while nobody can reach it.
    const entry = ENV_BACKED_SETTINGS[0]!;
    const failures = evaluate(new Map(), buckets(), [], 0, new Set());

    expect(failures.length).toBe(ENV_BACKED_SETTINGS.length);
    expect(failures[0]).toContain(entry.settingsPath);
    expect(failures[0]).toContain(entry.envVar);
    expect(failures[0]).toContain("Build the control");
  });

  it("passes the repository as it stands", () => {
    expect(evaluate(scanEnvReads(), BUCKETS)).toEqual([]);
  });
});
