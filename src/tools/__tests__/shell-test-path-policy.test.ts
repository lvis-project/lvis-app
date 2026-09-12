import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-test-policy-")));
  roots.push(root);
  const cwd = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(cwd); mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "outside");
  const facts = { dialect: "bash" as const, environment: { PATH: "/usr/bin:/bin", HOME: cwd, PWD: cwd } };
  const policy = (command: string) => findShellPathPolicyViolation(command, cwd, cwd, [], true, facts);
  return { cwd, outside, policy };
}

describe.skipIf(process.platform === "win32")("test expression path roles", () => {
  it.each([
    `value=$(printf '%s' ready); if [ "$value" = ready ]; then printf 'match\n'; fi`,
    `number=$(printf '%s' 204); if test "$number" -ge 200; then printf 'numeric\n'; fi`,
    `[ "$UNKNOWN" != value ]`,
    `test -n "$UNKNOWN"`,
    `test "$UNKNOWN" -lt 10`,
    `test -t "$UNKNOWN"`,
    `test -o "$UNKNOWN"`,
    `test -v SIMPLE_NAME`,
    `test ../outside/secret -eq 1`,
    `[ /etc/passwd = literal-data ]`,
    `[[ foo = f* ]]`,
    `[[ value =~ ^v.*$ ]]`,
    `[ "]" = "]" ]`,
  ])("admits only the proven scalar slots: %s", command => {
    expect(fixture().policy(command)).toBeNull();
  });

  it.each([
    `test -e ../outside/secret`,
    `[ ../outside/secret -nt ./local ]`,
    `[[ -e ../outside/secret ]]`,
  ])("retains a concrete filesystem boundary: %s", command => {
    expect(fixture().policy(command)?.kind).toBe("sandbox-boundary");
  });

  it("retains the sensitive-path guard for file predicates", () => {
    expect(fixture().policy(`test -e ${join(homedir(), ".ssh", "id_rsa")}`)?.kind).toBe("sensitive-path");
  });

  it.each([
    `test -e -f`,
    `[ -e -f ]`,
  ])("checks a leading-dash path operand before generic option handling: %s", command => {
    const { cwd, outside, policy } = fixture();
    symlinkSync(join(outside, "secret"), join(cwd, "-f"));
    expect(policy(command)?.kind).toBe("sandbox-boundary");
  });

  it.each([
    `test -e -/../../outside/secret`,
    `[ -e -/../../outside/secret ]`,
  ])("checks leading-dash traversal in an explicit path role: %s", command => {
    const { cwd, policy } = fixture();
    mkdirSync(join(cwd, "-"));
    expect(policy(command)?.kind).toBe("sandbox-boundary");
  });

  it.each([
    `test -e "$UNKNOWN"`,
    `[ "$UNKNOWN" -ef ./local ]`,
  ])("retains unresolved filesystem operands: %s", command => {
    const violation = fixture().policy(command);
    expect(violation?.kind).toBe("dynamic-path");
    expect(violation?.reason).toContain("unresolved command operand");
  });

  it("inspects substitutions and redirects before applying scalar roles", () => {
    const { policy } = fixture();
    expect(policy(`[ "$(cat ../outside/secret)" = value ]`)?.kind).toBe("sandbox-boundary");
    expect(policy(`[ "$UNKNOWN" = value ] > ../outside/result`)?.kind).toBe("sandbox-boundary");
  });

  it("prunes only a proven break branch and retains both unknown outcomes", () => {
    const { policy } = fixture();
    expect(policy(`for item in stop; do if [ "$item" = stop ]; then break; fi; cp ./local ../outside/result; done`)).toBeNull();
    expect(policy(`for item in one; do if [ "$UNKNOWN" = stop ]; then break; fi; cp ./local ../outside/result; done`)?.kind).toBe("sandbox-boundary");
  });

  it.each([
    `test "$UNKNOWN" -unknown value`,
    `test value -a other`,
    `test value -o other`,
    `test a b c d`,
    `[ value = value`,
    `[ value = value "$UNKNOWN"`,
    `test -v 'array[0]'`,
    `test -R "$UNKNOWN"`,
    `test $UNKNOWN = value`,
  ])("fails closed for an ambiguous or executable expression role: %s", command => {
    expect(fixture().policy(command)?.kind).toBe("dynamic-path");
  });

  it("does not transfer builtin roles to functions or external commands", () => {
    const { cwd, policy } = fixture();
    writeFileSync(join(cwd, "test"), `#!/bin/bash\ncat "$1"\n`, { mode: 0o700 });
    expect(policy(`test(){ cat "$1"; }; test ../outside/secret`)?.kind).toBe("sandbox-boundary");
    expect(policy(`./test ../outside/secret`)?.kind).toBe("sandbox-boundary");
  });
});
