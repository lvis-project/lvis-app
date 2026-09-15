import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { cleanupAsrtSandboxAfterCommand, getBuiltinShellSessionReadPolicy, initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { spawnConfinedChild } from "../../permissions/confined-child.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability } from "../../permissions/sandbox-capability.js";
import { asrtCanInitialize } from "../../permissions/__tests__/test-helpers.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { BashTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";
import { buildSafeChildEnv } from "../safe-env.js";

let root: string;
let cwd: string;
let profile: string;
let sessions: string;
let transcript: string;
const CONTENT = "saved-session-native-fixture\n";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-read-shell-")));
  cwd = join(root, "workspace");
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  transcript = join(sessions, "conversation.jsonl");
  mkdirSync(cwd); mkdirSync(sessions, { recursive: true });
  writeFileSync(transcript, CONTENT);
  vi.stubEnv("HOME", root);
  vi.stubEnv("LVIS_HOME", profile);
  vi.stubEnv("CLAUDE_CODE_TMPDIR", process.env.CLAUDE_CODE_TMPDIR);
  vi.stubEnv("CLAUDE_TMPDIR", process.env.CLAUDE_TMPDIR);
});
afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetActiveSandboxCapabilityForTest();
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("saved-session shell confinement", () => {
  it("native sandbox reads configured history while preserving the write floor and neighboring denies", async (test) => {
    if (!(await asrtCanInitialize())) return test.skip();
    const neighbors = ["secrets", "audit", "routine"].map((namespace) => {
      const dir = join(profile, namespace); mkdirSync(dir);
      const path = join(dir, "private.jsonl"); writeFileSync(path, "private-neighbor-fixture");
      return path;
    });
    const sibling = join(profile, "ordinary.txt"); writeFileSync(sibling, "ordinary-neighbor-fixture");
    const nestedCredential = join(sessions, ".ssh", "id_rsa");
    mkdirSync(join(sessions, ".ssh")); writeFileSync(nestedCredential, "nested-credential-fixture");
    const nestedEnvironment = join(sessions, ".env"); writeFileSync(nestedEnvironment, "nested-credential-fixture");
    const escape = join(sessions, "escape.jsonl"); symlinkSync(neighbors[0]!, escape);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const run = (command: string, writes = [cwd]) => spawnWithSandbox(command, cwd, writes, 15, prepareSandboxFixture(command, cwd));
    const read = await run("/bin/cat " + shellQuote(transcript));
    expect(read.isError, read.output).toBe(false);
    expect(read.metadata.sandboxed).toBe(true);
    expect(read.output).toContain(CONTENT.trim());
    for (const denied of [...neighbors, sibling, escape, nestedCredential, nestedEnvironment]) {
      const result = await run("/bin/cat " + shellQuote(denied));
      expect(result.isError, result.output).toBe(true);
      expect(result.output).not.toContain("neighbor-fixture");
      expect(result.output).not.toContain("credential-fixture");
    }
    const moved = join(cwd, "moved.jsonl");
    const created = join(sessions, "new.jsonl");
    for (const command of [
      "printf changed > " + shellQuote(transcript),
      "printf created > " + shellQuote(created),
      "/bin/rm " + shellQuote(transcript),
      "/bin/mv " + shellQuote(transcript) + " " + shellQuote(moved),
    ]) {
      // An existing broad write grant must not override saved-history integrity.
      const result = await run(command, [cwd, profile]);
      expect(result.isError, result.output).toBe(true);
    }
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
    expect(existsSync(created)).toBe(false);
    expect(existsSync(moved)).toBe(false);
  });

  it("public BashTool reads a configured session under strict path scope", async (test) => {
    if (!(await asrtCanInitialize())) return test.skip();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    setActiveSandboxCapability({
      kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "Native test sandbox initialized",
      confines: { filesystem: true, process: true, network: true },
    });
    const context = { cwd, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true, metadata: {} };
    const read = await new BashTool().execute({ command: "cat " + shellQuote(transcript), timeoutSeconds: 15 }, context);
    expect(read.isError, read.output).toBe(false);
    expect(read.metadata?.sandboxed).toBe(true);
    expect(read.output).toContain(CONTENT.trim());
    const write = await new BashTool().execute({ command: "printf changed > " + shellQuote(transcript), timeoutSeconds: 15 }, { ...context, extraAllowedDirectories: [profile] });
    expect(write.isError).toBe(true);
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
  });

  it("native sandbox grants builtin history reads without opening the same file to a confined child", async (test) => {
    if (!(await asrtCanInitialize())) return test.skip();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const command = "/bin/cat " + shellQuote(transcript);
    const builtin = await spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
    expect(builtin.isError, builtin.output).toBe(false);
    expect(builtin.output).toContain(CONTENT.trim());
    const ordinary = join(cwd, "ordinary.txt"); writeFileSync(ordinary, "ordinary-child-fixture");
    let wrapped = false;
    try {
      const child = await spawnConfinedChild({
        command: "/bin/cat", args: [ordinary, transcript], label: "session-read-confined-fixture",
        grantMode: "allow-list", allowRead: [cwd, profile], allowWrite: [cwd], baseEnv: buildSafeChildEnv(),
        onWrapped: () => { wrapped = true; },
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          timer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
          child.once("error", reject);
          child.once("close", resolve);
        });
        const stdout = Buffer.concat(output).toString("utf8");
        expect(wrapped).toBe(true);
        expect(code, Buffer.concat(errors).toString("utf8")).toBe(1);
        expect(stdout).toContain("ordinary-child-fixture");
        expect(stdout).not.toContain(CONTENT.trim());
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      if (wrapped) await cleanupAsrtSandboxAfterCommand();
    }
  });

  it.each(["user-data", "custom-literal", "custom-glob"] as const)("native sandbox preserves %s protection over the configured session root", async (kind, test) => {
    if (!(await asrtCanInitialize())) return test.skip();
    const denyRead = kind === "custom-literal" ? [profile] : kind === "custom-glob" ? [`${root}/configured-*`] : [];
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead,
      ...(kind === "user-data" ? { userDataDir: profile } : {}),
    });
    expect(getBuiltinShellSessionReadPolicy().allowRead).toEqual([]);
    expect(getBuiltinShellSessionReadPolicy().denyRead).toEqual(expect.arrayContaining(denyRead));
    const command = "/bin/cat " + shellQuote(transcript);
    const result = await spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
    expect(result.isError, result.output).toBe(true);
    expect(result.output).not.toContain(CONTENT.trim());
  });
});
