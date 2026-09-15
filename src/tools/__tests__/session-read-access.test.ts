import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";
import { canonicalizePathForMatch, caseFoldForMatch, getConfiguredSessionReadRoot, isConfiguredSessionReadPath, isSensitivePath } from "../../permissions/sensitive-paths.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { assertReadableFilePath } from "../file-read-core.js";
import { ensureFileAccess } from "../file-access-policy.js";
import { DeleteFileTool, GrepFilesTool, ListFilesTool, MoveFileTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import type { ToolExecutionContext } from "../types.js";

let root: string;
let profile: string;
let sessions: string;
let transcript: string;
let context: ToolExecutionContext;
const CONTENT = '{"role":"user","content":"saved-history-fixture"}\n';
const canonical = (path: string) => caseFoldForMatch(canonicalizePathForMatch(path));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-read-access-")));
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  transcript = join(sessions, "conversation.jsonl");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(root, "workspace"));
  writeFileSync(transcript, CONTENT);
  vi.stubEnv("LVIS_HOME", profile);
  context = { cwd: join(root, "workspace"), extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true, metadata: {} };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

describe("configured saved-session access", () => {
  it("reads and discovers real history through the public file surfaces outside the project", async () => {
    expect(getConfiguredSessionReadRoot()).toBe(sessions);
    expect(ensureFileAccess(transcript, context, "read")).toBeNull();
    expect(assertReadableFilePath(transcript, context.cwd, [])).toEqual({ ok: true, resolved: transcript });
    const read = await new ReadFileTool().execute({ path: transcript }, context);
    expect(read.isError, read.output).toBe(false);
    expect(read.output).toContain("saved-history-fixture");
    const listed = await new ListFilesTool().execute({ path: sessions }, context);
    expect(listed.isError, listed.output).toBe(false);
    expect(listed.output).toContain("conversation.jsonl");
    const searched = await new GrepFilesTool().execute({ path: sessions, pattern: "saved-history-fixture" }, context);
    expect(searched.isError, searched.output).toBe(false);
    expect(searched.output).toContain("conversation.jsonl");
  });

  it("protects writes, deletion and moves even with an encompassing directory grant", async () => {
    const broad = { ...context, extraAllowedDirectories: [root] };
    const results = [
      await new WriteFileTool().execute({ path: transcript, content: "changed" }, broad),
      await new WriteFileTool().execute({ path: join(sessions, "new.jsonl"), content: "changed" }, broad),
      await new DeleteFileTool().execute({ path: transcript }, broad),
      await new MoveFileTool().execute({ sourcePath: transcript, destinationPath: join(context.cwd, "moved.jsonl") }, broad),
    ];
    for (const result of results) expect(result.output).toContain("Sensitive path:");
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
    expect(getDefaultSensitiveReadDenyPaths()).not.toContain(sessions);
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(sessions);
    expect(isSensitivePath(canonical(transcript))).not.toBeNull();
  });

  it.each(["secrets", "audit", "routine", "subscription-runtimes"])("keeps the %s namespace private", async (namespace) => {
    const target = join(profile, namespace, "record.jsonl");
    mkdirSync(join(profile, namespace)); writeFileSync(target, "private-store-fixture");
    const result = await new ReadFileTool().execute({ path: target }, { ...context, extraAllowedDirectories: [root] });
    expect(result.output).toContain("Sensitive path:");
    expect(result.output).not.toContain("private-store-fixture");
    expect(isConfiguredSessionReadPath(canonical(target))).toBe(false);
  });

  it("does not extend the read grant to sibling, copied or isolated session roots", () => {
    for (const path of [join(profile, "ordinary"), join(root, "copy", ".lvis", "sessions", "other.jsonl"), join(profile, "side-chat", "sessions", "other.jsonl"), join(profile, "subagent", "sessions", "other.jsonl")]) {
      expect(isConfiguredSessionReadPath(canonical(path))).toBe(false);
      expect(ensureFileAccess(path, context, "read")?.isError).toBe(true);
    }
  });

  it("keeps nested credentials sensitive inside the readable namespace", () => {
    const target = join(sessions, ".ssh", "id_rsa");
    mkdirSync(join(sessions, ".ssh")); writeFileSync(target, "inert-credential-fixture");
    expect(isSensitivePath(canonical(target), "read")).not.toBeNull();
    expect(ensureFileAccess(target, context, "read")?.isError).toBe(true);
    const copiedStore = join(sessions, "copy", ".lvis", "sessions", "other.jsonl");
    mkdirSync(join(sessions, "copy", ".lvis", "sessions"), { recursive: true });
    writeFileSync(copiedStore, "copied-store-fixture");
    expect(ensureFileAccess(copiedStore, context, "read")?.isError).toBe(true);
  });

  it.skipIf(process.platform === "win32")("accepts a relocated application root but rejects escaping session links", () => {
    const alias = join(root, "profile-alias");
    symlinkSync(profile, alias);
    vi.stubEnv("LVIS_HOME", alias);
    expect(getConfiguredSessionReadRoot()).toBe(sessions);
    expect(ensureFileAccess(join(alias, "sessions", "conversation.jsonl"), context, "read")).toBeNull();
    const outside = join(root, "outside.jsonl"); writeFileSync(outside, "outside-fixture");
    symlinkSync(outside, join(sessions, "escape.jsonl"));
    expect(ensureFileAccess(join(sessions, "escape.jsonl"), context, "read")?.isError).toBe(true);
    expect(assertReadableFilePath(join(sessions, "escape.jsonl"), context.cwd, []).ok).toBe(false);
    const other = join(root, "other-profile"); mkdirSync(other);
    symlinkSync(sessions, join(other, "sessions")); vi.stubEnv("LVIS_HOME", other);
    expect(getConfiguredSessionReadRoot()).toBeUndefined();
    expect(isSensitivePath(canonical(transcript), "read")).not.toBeNull();
  });

  it("does not turn a credential-contained or pattern-containing root into a native grant", () => {
    for (const unsafe of [join(root, ".ssh"), join(root, "profile[other]")]) {
      vi.stubEnv("LVIS_HOME", unsafe);
      expect(getConfiguredSessionReadRoot()).toBeUndefined();
    }
  });

  it("passes the same read effect through permission and approval gates", async () => {
    const canonicalTargets = [{ filePath: transcript, canonicalPath: canonical(transcript) }];
    const common = { canonicalTargets, allowedDirectories: [canonical(context.cwd)], blockReadsOutsideWorkingDirectories: true };
    expect(PermissionManager.checkPathScope({ ...common, effect: "read" })).toMatchObject({ sensitiveHit: null, outOfAllowed: null });
    expect(PermissionManager.checkPathScope({ ...common, effect: "write" }).sensitiveHit).not.toBeNull();
    const send = vi.fn();
    const gate = new ApprovalGate({ send, isDestroyed: () => false } as never, undefined, 200);
    const request = { id: "session-read", category: "tool" as const, toolName: "read_file", source: "builtin" as const, mode: "default" as const, args: { path: transcript }, reason: "Read saved conversation", createdAt: Date.now(), target: { filePath: transcript }, isReadOnly: true };
    expect((await gate.requestAndWait(request)).choice).toBe("allow-once");
    expect((await gate.requestAndWait({ ...request, id: "session-write", isReadOnly: false })).choice).toBe("deny-once");
    expect((await gate.requestAndWait({ ...request, id: "session-directory-grant", kind: "out-of-allowed-dir" })).choice).toBe("deny-once");
    expect(send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });
});
