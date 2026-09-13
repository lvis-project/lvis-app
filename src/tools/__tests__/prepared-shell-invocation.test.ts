import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import * as resolver from "../../lib/shell-resolver.js";
import * as homeOwner from "../../permissions/sandbox-process-home.js";
import { claimPreparedShellInvocation, disposePreparedShellInvocation, matchesPreparedShellInvocation, prepareShellInvocation, preparedSandboxBootstrap, preparedSandboxEnvironment, preparedShellCommand, preparedShellFacts, transferPreparedShellInvocation, type PreparedShellInvocation } from "../prepared-shell-invocation.js";

const roots: string[] = [];
const handles: PreparedShellInvocation[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) disposePreparedShellInvocation(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function fixture(command = "printf '%s\\0' \"$HOME\" \"$TMPDIR\" \"$PWD\" \"$HTTPS_PROXY\" \"$SSL_CERT_FILE\"", sandboxed = true) {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-prepared-"))); roots.push(cwd);
  const plan = buildHostShellExecutionPlan({ platform: process.platform, requestedSandbox: sandboxed,
    activeCapability: sandboxed
      ? { kind: "asrt", confidence: "verified", platform: process.platform, reason: "Controlled sandbox fixture", confines: { filesystem: true, process: true, network: true } }
      : { kind: "none", confidence: "verified", platform: process.platform, reason: "Controlled plain fixture", confines: { filesystem: false, process: false, network: false } },
  });
  const identity = { command, executionCwd: cwd, resolvedCwd: cwd, toolUseId: "owned-invocation", plan };
  const handle = prepareShellInvocation(identity); handles.push(handle);
  return { cwd, identity, handle };
}

describe.skipIf(process.platform === "win32")("prepared shell facts and resource ownership", () => {
  it("delivers captured proxy settings to an actual plain shell without host secrets", () => {
    const proxies = {
      HTTP_PROXY: "http://upper.example:8080", http_proxy: "http://lower.example:8081",
      HTTPS_PROXY: "http://upper.example:8443", https_proxy: "http://lower.example:8444",
      ALL_PROXY: "socks5h://upper.example:1080", all_proxy: "socks5h://lower.example:1081",
      NO_PROXY: "localhost,.upper.example", no_proxy: "127.0.0.1,.lower.example",
    };
    for (const [key, value] of Object.entries(proxies)) vi.stubEnv(key, value);
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
    vi.stubEnv("BASH_ENV", "/nonexistent-shell-startup");
    vi.stubEnv("NODE_OPTIONS", "--invalid-child-option");
    const command = `printf '%s\\0' ${Object.keys(proxies).map((key) => `"$${key}"`).join(" ")}`
      + ' "${OPENAI_API_KEY-unset}" "${BASH_ENV-unset}" "${NODE_OPTIONS-unset}"';
    const { handle, cwd } = fixture(command, false);
    vi.stubEnv("HTTPS_PROXY", "http://changed.example:8080");
    const prepared = preparedShellCommand(handle);
    const result = spawnSync(prepared.shell.cmd, [...prepared.argv], { cwd, env: { ...prepared.environment }, timeout: 3000, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\0")).toEqual([...Object.values(proxies), "unset", "unset", "unset", ""]);
    expect(preparedShellFacts(handle).environment).toEqual(prepared.environment);
  });

  it("keeps ambient proxy settings out of sandbox preparation and accepts only a changed wrapper route", () => {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(key, "http://ambient.example:3128");
    }
    const { handle, cwd } = fixture('printf "%s\\0" "${HTTPS_PROXY-unset}" "${https_proxy-unset}" "${NO_PROXY-unset}"');
    const prepared = preparedShellCommand(handle);
    expect(prepared.environment).not.toHaveProperty("HTTPS_PROXY");
    const bootstrap = preparedSandboxBootstrap(handle);
    expect(bootstrap).not.toContain("ambient.example");
    const unchanged = spawnSync(prepared.shell.cmd, prepared.shell.shellArgs(bootstrap), { cwd, env: preparedSandboxEnvironment(handle, { ...process.env }), timeout: 3000, encoding: "utf8" });
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout.split("\0")).toEqual(["unset", "unset", "unset", ""]);
    const wrapped = preparedSandboxEnvironment(handle, { ...process.env, HTTPS_PROXY: "http://localhost:60080", https_proxy: "http://localhost:60080", NO_PROXY: "localhost" });
    const changed = spawnSync(prepared.shell.cmd, prepared.shell.shellArgs(bootstrap), { cwd, env: wrapped, timeout: 3000, encoding: "utf8" });
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout.split("\0")).toEqual(["http://localhost:60080", "http://localhost:60080", "localhost", ""]);
  });

  it("pins inner facts while preserving a late proxy and certificate overlay", () => {
    vi.stubEnv("TMPDIR", tmpdir());
    const { cwd, handle } = fixture();
    const prepared = preparedShellCommand(handle);
    expect(prepared.homePath).toBeDefined();
    expect(prepared.environment.HOME).toBe(prepared.homePath);
    expect(prepared.environment.TMPDIR).toBe(join(prepared.homePath!, "tmp"));
    expect(statSync(prepared.environment.TMPDIR!).mode & 0o777).toBe(0o700);
    const childEnv = preparedSandboxEnvironment(handle, { ...process.env, TMPDIR: "/late-wrapper-temp", HTTPS_PROXY: "http://proxy.invalid:1234", SSL_CERT_FILE: "/late-certificate.pem" });
    const result = spawnSync(prepared.shell.cmd, prepared.shell.shellArgs(preparedSandboxBootstrap(handle)), { cwd, env: childEnv, timeout: 3000 });
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().split("\0")).toEqual([prepared.homePath, prepared.environment.TMPDIR, cwd, "http://proxy.invalid:1234", "/late-certificate.pem", ""]);
  });

  it("reuses immutable facts after the ambient environment changes", () => {
    const { handle } = fixture();
    const facts = preparedShellFacts(handle);
    const before = { ...facts.environment };
    vi.stubEnv("HOME", "/changed-host-home"); vi.stubEnv("TMPDIR", "/changed-host-temp"); vi.stubEnv("PWD", "/changed-host-cwd");
    expect(preparedShellFacts(handle)).toBe(facts);
    expect(preparedShellFacts(handle).environment).toEqual(before);
    expect(Object.isFrozen(facts.environment)).toBe(true);
  });

  it("freezes the actual argv independently of the resolver descriptor", () => {
    const real = resolver.resolveShell("bash");
    let prefix = "";
    const descriptor = { ...real, shellArgs: (command: string) => ["-c", prefix + command] };
    vi.spyOn(resolver, "resolveShell").mockReturnValue(descriptor);
    const { handle, cwd } = fixture("printf original", false);
    const prepared = preparedShellCommand(handle);
    prefix = "printf changed; #"; descriptor.cmd = "/changed-interpreter";
    expect(Object.isFrozen(prepared.shell)).toBe(true); expect(Object.isFrozen(prepared.argv)).toBe(true);
    expect(() => { (prepared.argv as string[])[1] = "printf changed"; }).toThrow();
    const result = spawnSync(prepared.shell.cmd, [...prepared.argv], { cwd, env: { ...prepared.environment }, timeout: 3000, encoding: "utf8" });
    expect(result.status).toBe(0); expect(result.stdout).toBe("original");
  });

  it("binds the host-issued handle to the exact command, cwd, call and plan", () => {
    const { identity, handle } = fixture();
    expect(matchesPreparedShellInvocation(handle, identity)).toBe(true);
    for (const changed of [
      { ...identity, command: "printf changed" }, { ...identity, toolUseId: "other" },
      { ...identity, resolvedCwd: join(identity.resolvedCwd, "child") },
      { ...identity, requestedCwd: "." }, { ...identity, plan: { ...identity.plan } },
    ]) expect(matchesPreparedShellInvocation(handle, changed)).toBe(false);
    expect(matchesPreparedShellInvocation({} as PreparedShellInvocation, identity)).toBe(false);
    expect(() => preparedShellFacts({} as PreparedShellInvocation)).toThrow(/not issued/);
  });

  it("disposes a denied or otherwise unspawned call exactly once", () => {
    const { handle } = fixture(); const path = preparedShellCommand(handle).homePath!;
    expect(existsSync(path)).toBe(true); disposePreparedShellInvocation(handle); disposePreparedShellInvocation(handle);
    expect(existsSync(path)).toBe(false); expect(() => preparedShellFacts(handle)).toThrow(/no longer live/);
  });

  it("does not remove a live child's HOME when its caller releases preparation", async () => {
    const { cwd, handle } = fixture("printf ready; read -r finish");
    const prepared = preparedShellCommand(handle);
    const releaseClaim = claimPreparedShellInvocation(handle);
    const child = spawn(prepared.shell.cmd, prepared.shell.shellArgs(preparedSandboxBootstrap(handle)), { cwd, env: { ...prepared.environment }, stdio: ["pipe", "pipe", "pipe"] });
    const cleanup = transferPreparedShellInvocation(handle);
    releaseClaim();
    const closed = new Promise<void>((resolve) => child.once("close", () => { cleanup(); resolve(); }));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
      disposePreparedShellInvocation(handle);
      expect(existsSync(prepared.homePath!)).toBe(true);
      child.stdin.end("finish\n"); await closed;
      expect(existsSync(prepared.homePath!)).toBe(false);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
  });

  it("cleans its allocated HOME when cancellation arrives during preparation", () => {
    const controller = new AbortController();
    const create = vi.spyOn(homeOwner, "createSandboxProcessHome");
    const original = resolver.getBashCapabilities;
    vi.spyOn(resolver, "getBashCapabilities").mockImplementation((...args) => { const result = original(...args); controller.abort(); return result; });
    const cwd = process.cwd();
    const plan = buildHostShellExecutionPlan({ platform: process.platform, requestedSandbox: true,
      activeCapability: { kind: "asrt", confidence: "verified", platform: process.platform, reason: "Controlled sandbox fixture", confines: { filesystem: true, process: true, network: true } } });
    expect(() => prepareShellInvocation({ command: "printf ready", executionCwd: cwd, resolvedCwd: cwd, plan }, controller.signal)).toThrow();
    expect(create).toHaveBeenCalledOnce(); expect(existsSync(create.mock.results[0]!.value.path)).toBe(false);
  });

  it("keeps plain execution free of sandbox HOME allocation", () => {
    const create = vi.spyOn(homeOwner, "createSandboxProcessHome"); const { handle } = fixture("printf plain", false);
    expect(preparedShellCommand(handle).homePath).toBeUndefined(); expect(create).not.toHaveBeenCalled();
    expect(() => preparedSandboxBootstrap(handle)).toThrow(/no owned HOME/);
  });
});
