import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  evaluate,
  scanEnvReads,
} from "../../scripts/check-env-surface-policy.js";

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

  it("passes the repository as it stands", () => {
    expect(evaluate(scanEnvReads(), BUCKETS)).toEqual([]);
  });
});
