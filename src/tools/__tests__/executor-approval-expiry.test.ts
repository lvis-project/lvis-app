import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../../audit/audit-schema.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { getLocale, setLocale, type Locale } from "../../i18n/index.js";
import {
  ApprovalGate,
  IPC_APPROVAL_REQUEST,
  type ApprovalRequest,
} from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { userPermissionContext } from "./tool-context-fixture.js";

describe("tool approval expiration attribution", () => {
  let root: string;
  let workspace: string;
  let previousHome: string | undefined;
  let previousLocale: Locale;
  let audit: AuditLogger;
  let gate: ApprovalGate | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-approval-expiry-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    previousHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = join(root, "host-home");
    previousLocale = getLocale();
    setLocale("en");
    audit = new AuditLogger(join(root, "audit"));
    await audit.setupPermissionAuditChain("synthetic-approval-expiry-audit-secret");
  });

  afterEach(async () => {
    gate?.disposeAll();
    gate = undefined;
    vi.useRealTimers();
    await audit.close();
    setLocale(previousLocale);
    if (previousHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = previousHome;
    await cleanupTmpDir(root);
  });

  function start(kind: "tool" | "directory", signal?: AbortSignal) {
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const manager = new PermissionManager(join(root, "permissions.json"));
    const wc = makeMockWebContents();
    const sent = Promise.withResolvers<ApprovalRequest>();
    wc.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) sent.resolve(request);
    });
    // Use the real gate and its configured default deadline. Only wall time
    // advances virtually; no synthetic decision can manufacture host provenance.
    gate = new ApprovalGate(wc as never, undefined, undefined, audit);
    const logger = vi.spyOn(audit, "log");
    const executor = new ToolExecutor(
      registry, undefined, manager, undefined, gate, undefined, audit,
    );
    const result = executor.executeAll([
      {
        id: "approval-expiry-call",
        name: "write_probe",
        input: { path: join(kind === "tool" ? workspace : root, "notes.txt") },
      },
    ], {
      sessionId: "approval-expiry-session",
      ...(signal ? { abortSignal: signal } : {}),
      permissionContext: userPermissionContext({ additionalDirectories: [workspace] }),
    });
    return { execute, sent: sent.promise, result, logger };
  }

  function permissions(): PermissionAuditEntryInput[] {
    return readFileSync(audit.getPermissionAuditLogFile(), "utf8")
      .trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as PermissionAuditEntryInput);
  }

  it.each([
    { kind: "tool", locale: "en", marker: "Approval expired" },
    { kind: "tool", locale: "ko", marker: "승인 대기 시간 만료" },
    { kind: "directory", locale: "en", marker: "Approval expired" },
    { kind: "directory", locale: "ko", marker: "승인 대기 시간 만료" },
  ] as const)("reports $kind expiration in $locale without claiming a user refusal", async ({ kind, locale, marker }) => {
    setLocale(locale);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = start(kind);
    const request = await run.sent;
    expect(request.kind ?? "tool").toBe(kind === "directory" ? "out-of-allowed-dir" : "tool");
    expect(gate?.pendingCount).toBe(1);
    expect(run.execute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs - 1);
    expect(gate?.pendingCount).toBe(1);
    expect(run.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const [result] = await run.result;

    expect(result.is_error).toBe(true);
    expect(result.content).toContain(marker);
    expect(result.content).not.toMatch(/user denied|사용자가.*거부/);
    expect(run.execute).not.toHaveBeenCalled();
    expect(gate?.pendingCount).toBe(0);
    // An expired approval cannot be reused to authorize a late execution.
    expect(gate?.resolve(request.id, {
      requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac,
    })).toBeNull();

    const denied = permissions().find((entry) => entry.decision === "deny");
    expect(denied).toMatchObject({
      decision: "deny",
      denyReasons: [{ source: "approval-gate", reason: "approval request expired" }],
    });
    expect(run.logger.mock.calls.some(([entry]) => entry.output?.includes("[approval:timeout]"))).toBe(true);
    expect(run.logger.mock.calls.some(([entry]) => entry.toolCalls?.some((call) =>
      call.permissionDecision === "deny" && call.permissionReason === "approval request expired",
    ))).toBe(true);
    expect(existsSync(join(root, "permissions.json"))).toBe(false);
  });

  it.each(["tool", "directory"] as const)("attributes a rejected %s approval receipt to the host", async (kind) => {
    const run = start(kind);
    const request = await run.sent;
    gate?.resolve(request.id, {
      requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: "invalid-receipt",
    });
    const [result] = await run.result;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Approval blocked by host");
    expect(result.content).not.toMatch(/user denied|사용자가.*거부/);
    expect(run.execute).not.toHaveBeenCalled();
    expect(permissions().find((entry) => entry.decision === "deny")).toMatchObject({
      denyReasons: [{ source: "approval-gate", reason: "approval rejected by host" }],
    });
  });

  it.each(["tool", "directory"] as const)("retains an actual user denial of the %s request", async (kind) => {
    const run = start(kind);
    const request = await run.sent;
    expect(gate?.resolve(request.id, {
      requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac,
    })?.choice).toBe("deny-once");
    const [result] = await run.result;
    expect(result.is_error).toBe(true);
    expect(result.content).not.toContain("Approval expired");
    expect(run.execute).not.toHaveBeenCalled();
    if (kind === "tool") expect(result.content).toContain("user denied execution");
    expect(JSON.stringify(permissions())).not.toContain("approval request expired");
  });

  it("executes once after a real allow-once decision", async () => {
    const run = start("tool");
    const request = await run.sent;
    expect(gate?.resolve(request.id, {
      requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac,
    })?.choice).toBe("allow-once");
    const [result] = await run.result;
    expect(result.is_error).not.toBe(true);
    expect(result.content).toBe("wrote");
    expect(run.execute).toHaveBeenCalledTimes(1);
    expect(gate?.pendingCount).toBe(0);
  });

  it("retains turn cancellation instead of reporting expiration", async () => {
    const turn = new AbortController();
    const run = start("tool", turn.signal);
    await run.sent;
    turn.abort(new Error("user cancelled turn"));
    const [result] = await run.result;
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/cancel/i);
    expect(result.content).not.toContain("Approval expired");
    expect(run.execute).not.toHaveBeenCalled();
    expect(gate?.pendingCount).toBe(0);
  });
});
