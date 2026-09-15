import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability } from "../../permissions/sandbox-capability.js";
import { asrtCanInitialize } from "../../permissions/__tests__/test-helpers.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { BashTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

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
});
