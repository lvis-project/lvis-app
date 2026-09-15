import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { PermissionManager } from "../permission-manager.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { captureApprovalWorkingDirectory, recordApproval, lookupApproval, lookupUserDecision, __resetSessionStoreForTest } from "../user-approval-store.js";

describe("exact decisions scoped to the captured working directory", () => {
  let root: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-approval-directory-"));
    previousHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = join(root, "state");
    mkdirSync(join(root, "first"));
    mkdirSync(join(root, "second"));
    __resetSessionStoreForTest();
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = previousHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(root);
  });

  it.each([["bash", "builtin"], ["powershell", "builtin"], ["write_file", "builtin"], ["plugin_probe", "plugin"]])(
    "retains exact identity and directory scope for %s", async (tool, source) => {
      const first = join(root, "first");
      await recordApproval(tool, '{"value":"same"}', source, {
        scope: "persistent", verdictAtApproval: "medium", nlJustification: null,
        trustOrigin: "user-keyboard", approvalCacheKey: "existing-policy-key",
        workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
      });
      __resetSessionStoreForTest();
      expect(await lookupApproval(tool, '{"value":"same"}', source, "user-keyboard", "existing-policy-key", first)).not.toBeNull();
      expect(await lookupApproval(tool, '{"value":"same"}', source, "user-keyboard", "existing-policy-key", join(root, "second"))).toBeNull();
      expect(await lookupApproval(tool, '{"value":"changed"}', source, "user-keyboard", "existing-policy-key", first)).toBeNull();
      expect(await lookupApproval(tool, '{"value":"same"}', source, "llm-tool-arg", "existing-policy-key", first)).toBeNull();
      expect(await lookupApproval(tool, '{"value":"same"}', source, "user-keyboard", "different-policy-key", first)).toBeNull();
    },
  );

  it("retains legacy exact denies ahead of scoped allows without accepting legacy allows", async () => {
    const first = join(root, "first");
    const entry = { scope: "persistent" as const, verdictAtApproval: "medium" as const, nlJustification: null, trustOrigin: "user-keyboard" };
    await recordApproval("probe", "{}", "builtin", entry);
    expect(await lookupApproval("probe", "{}", "builtin", "user-keyboard", undefined, first)).toBeNull();
    await recordApproval("probe", "{}", "builtin", { ...entry, decision: "deny" });
    await recordApproval("probe", "{}", "builtin", { ...entry, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity });
    __resetSessionStoreForTest();
    expect(await lookupUserDecision("probe", "{}", "builtin", "user-keyboard", undefined, first)).toMatchObject({ decision: "deny" });
    expect(await lookupApproval("probe", "{}", "builtin", "user-keyboard", undefined, first)).toBeNull();
    expect(await lookupUserDecision("probe", "{}", "builtin", "user-keyboard", undefined, join(root, "second"))).toMatchObject({ decision: "deny" });
  });

  it("freezes an alias before approval and does not retarget the saved grant", async () => {
    const first = join(root, "first");
    const alias = join(root, "alias");
    symlinkSync(first, alias);
    const captured = captureApprovalWorkingDirectory(alias);
    expect(captured.identity).toBe(captureApprovalWorkingDirectory(first).identity);
    unlinkSync(alias);
    symlinkSync(join(root, "second"), alias);
    await recordApproval("probe", "{}", "builtin", {
      scope: "persistent", verdictAtApproval: "medium", nlJustification: null,
      workingDirectoryIdentity: captured.identity,
    });
    expect(await lookupApproval("probe", "{}", "builtin", undefined, undefined, first)).not.toBeNull();
    expect(await lookupApproval("probe", "{}", "builtin", undefined, undefined, alias)).toBeNull();
  });
  it("keeps the displayed and recorded scope fixed while an approval is pending", async () => {
    const first = join(root, "first");
    const alias = join(root, "alias");
    symlinkSync(first, alias);
    const evaluationContext = buildPermissionEvaluationContext({
      policyMode: "auto_review", headless: false, source: "builtin", category: "shell",
      trustOrigin: "user-keyboard", executionCwd: alias, allowedDirectories: [first],
      pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
    });
    const args = { command: "inspect_local_fixture" };
    const reviewer = await new PermissionManager(join(root, "permissions.json")).dispatchReviewer("bash", {
      source: "builtin", category: "shell", pathFields: [], finalInput: args,
      trustOrigin: "user-keyboard", executionCwd: alias, allowedDirectories: [first], sensitivePathsAdjacent: [],
    });
    let displayed: ApprovalRequest | undefined;
    const gate = new ApprovalGate({ isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel === "lvis:approval:request") displayed = request;
    } } as never);
    const pending = gate.requestAndWait({
      id: "alias-pending", category: "tool", toolName: "bash", toolCategory: "shell", source: "builtin",
      args, reason: "assessment unavailable", createdAt: Date.now(), trustOrigin: "user-keyboard",
      reviewerVerdict: reviewer.verdict, reviewerOutcome: reviewer.outcome,
      reviewerApprovalBasis: reviewer.approvalBasis, evaluationContext,
    });
    const frozen = captureApprovalWorkingDirectory(first);
    expect(displayed).toMatchObject({ persistentAllowAllowed: true, persistentApprovalCwd: frozen.path });
    expect(displayed).not.toHaveProperty("reviewerApprovalBasis");
    unlinkSync(alias);
    symlinkSync(join(root, "second"), alias);
    const snapshot = gate.getRequestSnapshot("alias-pending")!;
    expect(snapshot.workingDirectoryIdentity).toBe(frozen.identity);
    await recordApproval(snapshot.toolName, JSON.stringify(snapshot.args), snapshot.source, {
      scope: "persistent", verdictAtApproval: snapshot.verdictAtApproval, nlJustification: null,
      trustOrigin: snapshot.trustOrigin, workingDirectoryIdentity: snapshot.workingDirectoryIdentity,
      riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
    });
    gate.resolveFromDesktopRenderer("alias-pending", { requestId: "alias-pending", choice: "allow-always", nonce: displayed!.nonce, hmac: displayed!.hmac });
    await pending;
    expect(await lookupApproval("bash", JSON.stringify(args), "builtin", "user-keyboard", undefined, first)).not.toBeNull();
    expect(await lookupApproval("bash", JSON.stringify(args), "builtin", "user-keyboard", undefined, alias)).toBeNull();
  });

  it.each(["high", "forged", "changed-input"])("rejects %s evidence for remembering failed-review HIGH", async (caseName) => {
    const cwd = join(root, "first");
    const args = { command: caseName === "high" ? "rm -rf file" : "printf hello" };
    const reviewer = await new PermissionManager(join(root, "permissions.json")).dispatchReviewer("bash", {
      source: "builtin", category: "shell", pathFields: [], finalInput: args,
      trustOrigin: "user-keyboard", executionCwd: cwd, allowedDirectories: [cwd], sensitivePathsAdjacent: [],
    });
    if (caseName === "high") expect(reviewer.approvalBasis!.ruleVerdict).toBe("high");
    let displayed: ApprovalRequest | undefined;
    const gate = new ApprovalGate({ isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel === "lvis:approval:request") displayed = request;
    } } as never);
    const pending = gate.requestAndWait({
      id: "ineligible", category: "tool", toolName: "bash", toolCategory: "shell", source: "builtin",
      args: caseName === "changed-input" ? { command: "rm -rf file" } : args,
      reason: "safe title", createdAt: Date.now(), trustOrigin: "user-keyboard",
      reviewerVerdict: reviewer.verdict, reviewerOutcome: reviewer.outcome,
      reviewerApprovalBasis: caseName === "forged" ? { ...reviewer.approvalBasis!, ruleVerdict: "low" } : reviewer.approvalBasis,
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "auto_review", headless: false, source: "builtin", category: "shell",
        trustOrigin: "user-keyboard", executionCwd: cwd, allowedDirectories: [cwd],
        pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
    });
    expect(displayed).toMatchObject({ persistentAllowAllowed: false, allowedChoices: ["allow-once", "deny-once"] });
    gate.resolveFromDesktopRenderer("ineligible", { requestId: "ineligible", choice: "deny-once", nonce: displayed!.nonce, hmac: displayed!.hmac });
    await pending;
  });

});
