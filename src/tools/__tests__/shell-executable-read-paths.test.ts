import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectShellExecution, type ShellExecutionFacts } from "../../shared/shell-execution.js";
import { collectShellExecutableReadPaths } from "../shell-executable-read-paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-executable-paths-")));
  roots.push(root);
  const cwd = join(root, "work");
  const first = join(root, "first-bin");
  const second = join(root, "second-bin");
  for (const dir of [cwd, first, second]) mkdirSync(dir);
  const facts: ShellExecutionFacts = {
    dialect: "bash",
    environment: { PATH: [first, second].join(delimiter), HOME: root, PWD: cwd },
    prefixAssignmentRhs: "incoming",
  };
  const executable = (name: string, dir = first): string => {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return path;
  };
  const collect = (command: string, supplied = facts): readonly string[] => collectShellExecutableReadPaths(command, cwd, supplied);
  return { root, cwd, first, second, facts, executable, collect };
}

describe.skipIf(process.platform === "win32")("shell executable read paths", () => {
  it("selects the first executable from the captured PATH and returns only immutable file paths", () => {
    const f = fixture();
    const selected = f.executable("probe");
    f.executable("probe", f.second);
    const paths = f.collect("probe; probe");
    expect(paths).toEqual([selected]);
    expect(paths).not.toContain(f.first);
    expect(paths).not.toContain(f.root);
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it("does not mistake the event lookup-context flag for an actual builtin", () => {
    const f = fixture();
    const probe = f.executable("probe");
    f.executable("printf");
    expect(f.collect("probe; printf '%s' probe")).toEqual([probe]);
  });

  it("retains both lexical and real executable paths for symlinks", () => {
    const f = fixture();
    const target = f.executable("actual", f.second);
    const link = join(f.first, "probe");
    symlinkSync(target, link);
    expect(f.collect("probe")).toEqual([link, target]);
  });

  it("checks both a sensitive symlink name and its sensitive target", () => {
    const f = fixture();
    const safe = f.executable("safe", f.second);
    symlinkSync(safe, join(f.first, ".env"));
    const sensitive = f.executable(".env", f.second);
    symlinkSync(sensitive, join(f.first, "probe"));
    f.executable("probe", f.second);
    expect(f.collect(".env; probe")).toEqual([]);
  });

  it("omits literal pattern bytes that the filesystem transport would broaden", () => {
    const f = fixture();
    for (const name of ["probe*", "probe?", "probe[one]"]) {
      f.executable(name);
      expect(f.collect(quote(name))).toEqual([]);
    }
    const patternDirectory = join(f.root, "bin[one]");
    mkdirSync(patternDirectory);
    f.executable("probe", patternDirectory);
    expect(f.collect("probe", { ...f.facts, environment: { ...f.facts.environment, PATH: patternDirectory } })).toEqual([]);
    const target = f.executable("actual*", f.second);
    symlinkSync(target, join(f.first, "linked"));
    expect(f.collect("linked")).toEqual([]);
  });

  it("does not treat directories, missing entries or nonexecutable files as resources", () => {
    const f = fixture();
    mkdirSync(join(f.first, "directory"));
    const regular = f.executable("plain-file");
    chmodSync(regular, 0o644);
    expect(f.collect("missing; directory; plain-file")).toEqual([]);
    const fallback = f.executable("plain-file", f.second);
    expect(f.collect("plain-file")).toEqual([fallback]);
  });

  it("supports builtin command queries without granting unrelated argument data", () => {
    const f = fixture();
    const probe = f.executable("probe");
    const other = f.executable("other");
    expect(f.collect("command -v probe; command -V other; printf '%s' probe")).toEqual([probe, other]);
    expect(f.collect("command -v printf")).toEqual([]);
  });

  it("does not grant an executable when command lookup finds a shell keyword", () => {
    const f = fixture();
    f.executable("if");
    f.executable("time");
    expect(f.collect("command -v if; command -V if; command -v time")).toEqual([]);
  });

  it("distinguishes a query from external which and preserves its all-candidates option", () => {
    const f = fixture();
    const which = f.executable("which");
    const first = f.executable("probe");
    const second = f.executable("probe", f.second);
    expect(f.collect("which probe")).toEqual([which, first]);
    expect(f.collect("which -a probe")).toEqual([which, first, second]);
    expect(f.collect("which --help probe")).toEqual([which]);
    expect(f.collect("which -- probe")).toEqual([which, first]);
  });

  it("does not grant lookup targets when the external query program is unavailable", () => {
    const f = fixture();
    f.executable("probe");
    expect(f.collect("which probe")).toEqual([]);
  });

  it("follows function bodies and skips shadowed executable and command-query names", () => {
    const f = fixture();
    f.executable("probe");
    f.executable("which");
    expect(f.collect("probe(){ printf done; }; probe; command -v probe; command -V probe")).toEqual([]);
    expect(f.collect("which(){ printf done; }; which probe")).toEqual([]);
    expect(f.collect("command(){ printf done; }; command -v probe")).toEqual([]);
  });

  it("exposes a frozen snapshot of defined functions on the canonical event", () => {
    const f = fixture();
    const seen: (readonly string[])[] = [];
    inspectShellExecution("probe(){ :; }; command -v probe", f.cwd, f.facts, {
      path() {},
      command(event) {
        expect(Object.isFrozen(event.definedFunctions)).toBe(true);
        seen.push(event.definedFunctions);
      },
    });
    expect(seen).toEqual([["probe"]]);
  });

  it("does not extend ambient PATH capabilities after command-local or persistent PATH changes", () => {
    const f = fixture();
    f.executable("probe");
    f.executable("probe", f.second);
    expect(f.collect(`PATH=${quote(f.second)} probe`)).toEqual([]);
    expect(f.collect(`PATH=${quote(f.second)}; probe`)).toEqual([]);
    expect(f.collect(`env PATH=${quote(f.second)} probe`)).toEqual([]);
    expect(f.collect("env -i probe")).toEqual([]);
    expect(f.collect("env -u PATH probe")).toEqual([]);
  });

  it("keeps an explicitly restored identical PATH distinct from an absent PATH", () => {
    const f = fixture();
    const probe = f.executable("probe");
    expect(f.collect(`env -i PATH=${quote(f.facts.environment.PATH!)} probe`)).toEqual([probe]);
    expect(f.collect("probe", { ...f.facts, environment: { HOME: f.root } })).toEqual([]);
  });

  it("distinguishes shell PATH lookup from the PATH inherited by external wrappers and queries", () => {
    const f = fixture();
    const probe = f.executable("probe");
    const env = f.executable("env");
    const timeout = f.executable("timeout");
    const which = f.executable("which");
    const unexported = `unset PATH; PATH=${quote(f.facts.environment.PATH!)};`;
    expect(f.collect(`${unexported} probe`)).toEqual([probe]);
    expect(f.collect(`${unexported} command -v probe`)).toEqual([probe]);
    expect(f.collect(`${unexported} env probe`)).toEqual([env]);
    expect(f.collect(`${unexported} timeout 2 env probe`)).toEqual([timeout]);
    expect(f.collect(`${unexported} which probe`)).toEqual([which]);
    expect(f.collect(`${unexported} export PATH; env probe`)).toEqual([env, probe]);
    inspectShellExecution(`${unexported} env probe`, f.cwd, f.facts, {
      path() {},
      command(event) {
        expect(Object.isFrozen(event.exportedEnvironment)).toBe(true);
        if (event.argv[0] === "probe") {
          expect(event.environment.PATH).toBe(f.facts.environment.PATH);
          expect(event.exportedEnvironment.PATH).toBeUndefined();
        }
      },
    });
  });

  it("resolves relative PATH entries at each proven event cwd", () => {
    const f = fixture();
    const child = join(f.cwd, "child");
    for (const dir of [join(f.cwd, "bin"), child, join(child, "bin")]) mkdirSync(dir);
    const original = f.executable("probe", join(f.cwd, "bin"));
    const changed = f.executable("probe", join(child, "bin"));
    const facts = { ...f.facts, environment: { ...f.facts.environment, PATH: "bin" } };
    expect(f.collect("probe", facts)).toEqual([original]);
    expect(f.collect("cd child && probe", facts)).toEqual([changed]);
  });

  it("resolves empty PATH entries to a proven cwd without granting that directory", () => {
    const f = fixture();
    const local = f.executable("probe", f.cwd);
    f.executable("probe");
    expect(f.collect("probe", { ...f.facts, environment: { ...f.facts.environment, PATH: "" } })).toEqual([local]);
    expect(f.collect("probe", { ...f.facts, environment: { ...f.facts.environment, PATH: `:${f.first}` } })).toEqual([local]);
  });

  it("does not guess relative PATH lookup after a possible mutation makes cwd unresolved", () => {
    const f = fixture();
    mkdirSync(join(f.cwd, "child"));
    f.executable("probe", f.cwd);
    const facts = { ...f.facts, environment: { ...f.facts.environment, PATH: "." } };
    expect(f.collect("unknown; cd child && probe", facts)).toEqual([]);
  });

  it("grants an absolute executable only when captured PATH resolves the same file", () => {
    const f = fixture();
    const selected = f.executable("probe");
    const unselected = f.executable("probe", f.second);
    expect(f.collect(quote(selected))).toEqual([selected]);
    expect(f.collect(quote(unselected))).toEqual([]);
    expect(f.collect(`./probe`)).toEqual([]);
  });

  it("collects unambiguous wrappers without granting option values as commands", () => {
    const f = fixture();
    const timeout = f.executable("timeout");
    const nice = f.executable("nice");
    const probe = f.executable("probe");
    const data = f.executable("2");
    expect(f.collect("timeout 2 nice -n 2 probe")).toEqual([timeout, nice, probe]);
    expect(f.collect("timeout 2 probe")).not.toContain(data);
    expect(f.collect("command probe")).toEqual([probe]);
    expect(f.collect("command -p probe")).toEqual([]);
  });

  it("omits wrapper lookup when flattened environment or cwd loses its lookup state", () => {
    const f = fixture();
    f.executable("env");
    f.executable("timeout");
    const probe = f.executable("probe");
    expect(f.collect(`timeout 2 env -i PATH=${quote(f.facts.environment.PATH!)} probe`)).toEqual([probe]);
    expect(f.collect(`env -C ${quote(f.cwd)} probe`)).toEqual([probe]);
    expect(f.collect("timeout(){ :; }; timeout 2 probe")).toEqual([]);
  });

  it("follows canonical nested shell programs but never arbitrary program argument strings", () => {
    const f = fixture();
    const shell = f.executable("bash");
    const probe = f.executable("probe");
    expect(f.collect("bash -c 'probe'")).toEqual([shell, probe]);
    expect(f.collect("printf '%s' 'probe'")).toEqual([]);
  });

  it("throws on later invalid analysis instead of returning earlier executable grants", () => {
    const f = fixture();
    f.executable("probe");
    expect(() => f.collect("probe; if")).toThrow();
    expect(() => f.collect("probe; eval value")).toThrow();
    expect(() => f.collect("probe; timeout --unknown 2 probe")).toThrow();
  });
});
