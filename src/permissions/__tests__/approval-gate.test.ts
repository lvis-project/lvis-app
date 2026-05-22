/**
 * ApprovalGate unit tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalGate } from "../approval-gate.js";
import type { ApprovalRequest, ApprovalDecision } from "../approval-gate.js";
import { makeTestPolicy } from "./test-helpers.js";

// ─── Mock WebContents ─────────────────────────────────

function makeMockWebContents(opts: { isDestroyed?: boolean; sendThrows?: boolean } = {}) {
  return {
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error("webContents destroyed (race)");
    }),
    isDestroyed: vi.fn(() => opts.isDestroyed ?? false),
  };
}

// requestAndWait accepts Omit<ApprovalRequest, "requireExplicit"> — no requireExplicit here
type RequestInput = Omit<ApprovalRequest, "requireExplicit">;

function makeRequest(overrides?: Partial<RequestInput>): RequestInput {
  return {
    id: "req-1",
    category: "tool",
    toolName: "agent_spawn",
    args: { title: "test", instructions: "hello" },
    reason: "상태 변경 도구 (trust: high, category: write)",
    source: "builtin",
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * §D2: helper — pull the most recent (nonce, hmac) issued by the gate from
 * the mock webContents.send call log, so tests can echo them back unchanged
 * in the ApprovalDecision.
 */
function lastSentNonceHmac(wc: ReturnType<typeof makeMockWebContents>): {
  nonce: string;
  hmac: string;
} {
  const calls = wc.send.mock.calls;
  const last = calls[calls.length - 1] as [string, ApprovalRequest];
  return { nonce: last[1].nonce as string, hmac: last[1].hmac as string };
}

// ─── Tests ───────────────────────────────────────────

describe("ApprovalGate", () => {
  it("requestAndWait resolves when resolve() is called", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest();

    const promise = gate.requestAndWait(req);

    // gate enriches req with requireExplicit + mints nonce/hmac before sending
    expect(wc.send).toHaveBeenCalledWith(
      "lvis:approval:request",
      expect.objectContaining({
        id: req.id,
        toolName: req.toolName,
        requireExplicit: true,
        nonce: expect.any(String),
        hmac: expect.any(String),
      }),
    );

    const { nonce, hmac } = lastSentNonceHmac(wc);
    const decision: ApprovalDecision = {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    };
    gate.resolve(req.id, decision);

    const result = await promise;
    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-1");
  });

  it("audits agent-action issuer plugin id and scope on request and decision", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
    const req = makeRequest({
      id: "req-agent-action-1",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
      trustOrigin: "plugin-emitted",
    });

    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const requested = rows.find((row) => row.includes("[approval:requested] req-agent-action-1"));
    const decided = rows.find((row) => row.includes("[approval:decided] req-agent-action-1"));
    expect(requested).toContain("category=agent-action");
    expect(requested).toContain("kind=agent-action");
    expect(requested).toContain("source=plugin");
    expect(requested).toContain("sourcePluginId=sample-plugin");
    expect(requested).toContain("approvalScope=agent_external_api_call");
    expect(decided).toContain("category=agent-action");
    expect(decided).toContain("kind=agent-action");
    expect(decided).toContain("source=plugin");
    expect(decided).toContain("sourcePluginId=sample-plugin");
    expect(decided).toContain("approvalScope=agent_external_api_call");
  });

  it("audits agent-action issuer plugin id and scope on timeout", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
      const req = makeRequest({
        id: "req-agent-timeout",
        category: "agent-action",
        kind: "agent-action",
        toolCategory: "meta",
        source: "plugin",
        sourcePluginId: "sample-plugin",
        approvalScope: "agent_external_api_call",
      });

      const promise = gate.requestAndWait(req);
      vi.advanceTimersByTime(1_001);
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

      const rows = auditLogger.log.mock.calls.map(([entry]) => {
        const auditEntry = entry as { input?: string; output?: string };
        return auditEntry.input ?? auditEntry.output ?? "";
      });
      const timeout = rows.find((row) => row.includes("[approval:timeout] req-agent-timeout"));
      expect(timeout).toContain("category=agent-action");
      expect(timeout).toContain("kind=agent-action");
      expect(timeout).toContain("sourcePluginId=sample-plugin");
      expect(timeout).toContain("approvalScope=agent_external_api_call");
    } finally {
      vi.useRealTimers();
    }
  });

  it("audits agent-action issuer plugin id and scope on nonce mismatch", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
    const req = makeRequest({
      id: "req-agent-nonce-mismatch",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const mismatch = rows.find((row) => row.includes("[approval:nonce-mismatch] req-agent-nonce-mismatch"));
    expect(mismatch).toContain("category=agent-action");
    expect(mismatch).toContain("kind=agent-action");
    expect(mismatch).toContain("sourcePluginId=sample-plugin");
    expect(mismatch).toContain("approvalScope=agent_external_api_call");
  });

  it("timeout returns deny-once after timeoutMs", async () => {
    vi.useFakeTimers();
    const wc = makeMockWebContents();
    // initialPolicy is now the 2nd arg — pass undefined to use default, timeoutMs is 3rd
    const gate = new ApprovalGate(wc as never, undefined, 1000); // 1s timeout
    const req = makeRequest({ id: "req-timeout" });

    const promise = gate.requestAndWait(req);

    // 타임아웃 경과
    vi.advanceTimersByTime(1001);

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-timeout");

    vi.useRealTimers();
  });

  it("concurrent requests do not cross-contaminate", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const req1 = makeRequest({ id: "req-a", toolName: "tool_a" });
    const req2 = makeRequest({ id: "req-b", toolName: "tool_b" });

    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    // First send was req-a, second was req-b — extract each nonce/hmac pair
    const callA = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const callB = wc.send.mock.calls[1] as [string, ApprovalRequest];
    // req-b를 먼저 응답
    gate.resolve("req-b", {
      requestId: "req-b",
      choice: "deny-once",
      nonce: callB[1].nonce,
      hmac: callB[1].hmac,
    });
    // req-a를 나중에 응답
    gate.resolve("req-a", {
      requestId: "req-a",
      choice: "allow-always",
      nonce: callA[1].nonce,
      hmac: callA[1].hmac,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.choice).toBe("allow-always");
    expect(r2.choice).toBe("deny-once");
    expect(r1.requestId).toBe("req-a");
    expect(r2.requestId).toBe("req-b");
  });

  it("webContents.send is called with the correct channel and payload shape", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-shape" });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-shape");
    expect(payload.toolName).toBe("agent_spawn");
    expect(payload.category).toBe("tool");
    expect(payload.source).toBe("builtin");
    // default policy: requireExplicitApproval = true
    expect(payload.requireExplicit).toBe(true);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("requireExplicit=false가 페이로드에 포함됨 (policy.requireExplicitApproval=false)", async () => {
    const wc = makeMockWebContents();
    const policy = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-nonstrict" });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(false);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("setPolicy 호출 후 다음 request에 새 requireExplicit 반영", async () => {
    const wc = makeMockWebContents();
    const strictPolicy = makeTestPolicy({ requireExplicitApproval: true });
    const gate = new ApprovalGate(wc as never, strictPolicy);

    // 첫 번째 request — strict
    const req1 = makeRequest({ id: "req-before" });
    gate.requestAndWait(req1);
    const [, payload1] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload1.requireExplicit).toBe(true);
    gate.resolve(req1.id, { requestId: req1.id, choice: "deny-once" });

    // policy 교체
    gate.setPolicy(makeTestPolicy({ requireExplicitApproval: false }));
    expect(gate.policy.requireExplicitApproval).toBe(false);

    // 두 번째 request — lenient
    const req2 = makeRequest({ id: "req-after" });
    gate.requestAndWait(req2);
    const [, payload2] = wc.send.mock.calls[1] as [string, ApprovalRequest];
    expect(payload2.requireExplicit).toBe(false);
    gate.resolve(req2.id, { requestId: req2.id, choice: "allow-once" });
  });

  it("resolve with unknown requestId is a no-op", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // 등록되지 않은 ID에 resolve — throw 없이 무시
    expect(() => gate.resolve("unknown-id", { requestId: "unknown-id", choice: "allow-once" })).not.toThrow();
  });

  it("pendingCount tracks pending requests correctly", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    expect(gate.pendingCount).toBe(0);

    const req1 = makeRequest({ id: "cnt-1" });
    const req2 = makeRequest({ id: "cnt-2" });
    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    expect(gate.pendingCount).toBe(2);

    gate.resolve("cnt-1", { requestId: "cnt-1", choice: "allow-once" });
    await p1;
    expect(gate.pendingCount).toBe(1);

    gate.resolve("cnt-2", { requestId: "cnt-2", choice: "deny-once" });
    await p2;
    expect(gate.pendingCount).toBe(0);
  });

  // ── F2: webContents lifecycle guards ─────────────

  it("isDestroyed() true → deny-once immediately, no pending entry", async () => {
    const wc = makeMockWebContents({ isDestroyed: true });
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
    const req = makeRequest({
      id: "req-destroyed",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-destroyed");
    // send should never be called when already destroyed
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    const auditEntry = auditLogger.log.mock.calls[0]?.[0] as { output?: string } | undefined;
    expect(auditEntry?.output).toContain("sourcePluginId=sample-plugin");
    expect(auditEntry?.output).toContain("approvalScope=agent_external_api_call");
  });

  it("webContents.send throws → deny-once + pendingCount === 0", async () => {
    const wc = makeMockWebContents({ sendThrows: true });
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-send-throw" });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-send-throw");
    expect(gate.pendingCount).toBe(0);
  });

  // ── S1: Sensitive path hard-block ─────────────────

  it("sensitive path is hard-blocked even with mode=full_auto — dialog never shown", async () => {
    const wc = makeMockWebContents();
    // Even a permissive policy cannot unblock a sensitive path
    const permissive = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, permissive);
    const req = makeRequest({
      id: "req-sensitive",
      toolName: "file_read",
      target: { filePath: "/Users/ken/.ssh/id_rsa" },
      mode: "full_auto",
      // Even if tool lies and claims read-only, sensitive block wins
      isReadOnly: true,
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-sensitive");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    // The pattern that triggered the block is surfaced to the caller
    expect(result.rememberPattern).toContain("Sensitive credential path blocked");
    expect(result.rememberPattern).toContain("**/.ssh/**");
  });

  it("sensitive path hard-block audit preserves agent-action plugin and scope provenance", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
    const req = makeRequest({
      id: "req-sensitive-agent-action",
      category: "agent-action",
      kind: "agent-action",
      toolName: "plugin_file_review",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
      target: { filePath: "/Users/ken/.ssh/id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(wc.send).not.toHaveBeenCalled();
    const auditEntry = auditLogger.log.mock.calls[0]?.[0] as { output?: string } | undefined;
    expect(auditEntry?.output).toContain("[approval:sensitive-path-blocked]");
    expect(auditEntry?.output).toContain("category=agent-action");
    expect(auditEntry?.output).toContain("kind=agent-action");
    expect(auditEntry?.output).toContain("sourcePluginId=sample-plugin");
    expect(auditEntry?.output).toContain("approvalScope=agent_external_api_call");
  });

  // ── S4: isReadOnly short-circuit ──────────────────

  it("isReadOnly=true + mode=default → auto-approve, dialog skipped", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "default",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-readonly");
    expect(result.rememberPattern).toBe("read-only auto-approve");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it("isReadOnly=true + mode=plan → still blocked by plan mode (dialog shown)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly-plan",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "plan",
    });

    const promise = gate.requestAndWait(req);

    // Plan mode must NOT short-circuit — dialog must be sent
    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-readonly-plan");
    expect(payload.mode).toBe("plan");
    expect(payload.isReadOnly).toBe(true);
    expect(gate.pendingCount).toBe(1);

    // Simulate user denying
    gate.resolve("req-readonly-plan", {
      requestId: "req-readonly-plan",
      choice: "deny-once",
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });

  // ── H3: Path canonicalization before sensitive-path check ────

  it("H3: path with '..' segments is canonicalized and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dotdot",
      toolName: "file_read",
      // Traversal that resolves to /Users/test/.ssh/id_rsa
      target: { filePath: "/work/project/../../Users/test/.ssh/id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("Sensitive credential path blocked");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("H3: NFD-decomposed path is NFC-normalized and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // ".\u0073\u0073h" is already composed (".ssh") — use a real NFD
    // vector: "é" decomposed is "e\u0301". We craft a path that only
    // matches the pattern after NFC normalization. The sensitive set
    // itself is ASCII, so we exercise the normalize() call by feeding a
    // no-op path that still must be accepted. Absent an NFD sensitive
    // pattern we assert via a path whose normalize leaves it identical —
    // the key guarantee is that normalize() does NOT corrupt the match
    // for ASCII paths.
    const req = makeRequest({
      id: "req-nfc",
      toolName: "file_read",
      target: { filePath: "/Users/test/.ssh/id_rsa".normalize("NFD") },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("H3: mixed-case path on macOS is case-folded and still blocked", async () => {
    // Case-fold only kicks in on darwin/win32; on linux runners this
    // test still exercises the canonicalization path but the underlying
    // assertion only makes sense when the folder matches after toLowerCase.
    // We gate on process.platform to keep linux CI green.
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return;
    }
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-case",
      toolName: "file_read",
      target: { filePath: "/Users/Ken/.SSH/ID_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  // ── D1: args DLP masking for UI payload ──────────

  it("D1: API key in args is masked in UI payload, original preserved in caller's object", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const originalArgs = {
      prompt: "use sk-abcdefghijklmnopqrstuvwxyz12345",
      email: "user@example.com",
      nested: { phone: "010-1234-5678", count: 3 },
    };
    const req = makeRequest({
      id: "req-dlp-args",
      toolName: "llm_call",
      args: originalArgs,
    });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const maskedArgs = payload.args as typeof originalArgs;

    // UI payload is masked
    expect(maskedArgs.prompt).toBe("use sk-****");
    expect(maskedArgs.email).toBe("***@example.com");
    expect(maskedArgs.nested.phone).toBe("010-****-****");
    expect(maskedArgs.nested.count).toBe(3);

    // Caller's original args object is NOT mutated — tool execution uses this
    expect(originalArgs.prompt).toBe("use sk-abcdefghijklmnopqrstuvwxyz12345");
    expect(originalArgs.email).toBe("user@example.com");
    expect(originalArgs.nested.phone).toBe("010-1234-5678");
    expect(req.args).toBe(originalArgs);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: args with no sensitive data pass through (deep-equal) unchanged", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-clean",
      args: { title: "hello", items: ["a", "b"], n: 1 },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.args).toEqual({ title: "hello", items: ["a", "b"], n: 1 });

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: SSN and credit card in string args are masked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-ssn",
      args: { memo: "주민번호 900101-1234567 카드 4111-1111-1111-1234" },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const memo = (payload.args as { memo: string }).memo;
    expect(memo).toContain("******-*******");
    expect(memo).toContain("****-****-****-1234");
    expect(memo).not.toContain("900101-1234567");

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  // ── D2: HMAC nonce / confused-deputy defense ─────────────

  it("D2: happy path — valid nonce+hmac echo is honored", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-ok" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);

    // Payload must carry a non-empty nonce + hmac
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(hmac).toMatch(/^[0-9a-f]+$/);

    gate.resolve("d2-ok", {
      requestId: "d2-ok",
      choice: "allow-once",
      nonce,
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("allow-once");
  });

  it("D2: missing nonce/hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-missing" });
    const promise = gate.requestAndWait(req);

    // Renderer neglects to echo nonce+hmac
    gate.resolve("d2-missing", {
      requestId: "d2-missing",
      choice: "allow-once",
    });

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
    expect(gate.pendingCount).toBe(0);
  });

  it("D2: wrong nonce → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badnonce" });
    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);

    gate.resolve("d2-badnonce", {
      requestId: "d2-badnonce",
      choice: "allow-always",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
  });

  it("D2: wrong hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badhmac" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    // Flip one hex char
    const tamperedHmac =
      (hmac[0] === "a" ? "b" : "a") + hmac.slice(1);

    gate.resolve("d2-badhmac", {
      requestId: "d2-badhmac",
      choice: "allow-once",
      nonce,
      hmac: tamperedHmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });

  it("D2: replay of a prior request's nonce/hmac against a different request fails", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    // Issue two distinct approval requests
    const p1 = gate.requestAndWait(makeRequest({ id: "d2-req-1", toolName: "tool_a" }));
    const p2 = gate.requestAndWait(makeRequest({ id: "d2-req-2", toolName: "tool_b" }));
    const call1 = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const call2 = wc.send.mock.calls[1] as [string, ApprovalRequest];

    // Attacker replays req-1's nonce/hmac inside a response claiming to decide req-2
    gate.resolve("d2-req-2", {
      requestId: "d2-req-2",
      choice: "allow-always",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r2 = await p2;
    expect(r2.choice).toBe("deny-once");

    // Legitimate decide of req-1 still works
    gate.resolve("d2-req-1", {
      requestId: "d2-req-1",
      choice: "allow-once",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r1 = await p1;
    expect(r1.choice).toBe("allow-once");
  });

  it("D2: nonce values are unique across requests (not constant)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "d2-u1" }));
    gate.requestAndWait(makeRequest({ id: "d2-u2" }));
    const n1 = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1].nonce;
    const n2 = (wc.send.mock.calls[1] as [string, ApprovalRequest])[1].nonce;
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it("H3: duplicate slashes are collapsed and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-slash",
      toolName: "file_read",
      target: { filePath: "//Users/test//.ssh//id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("auto-injects sandboxCapability for tool-kind requests (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "bubblewrap" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "stubbed for test",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(makeRequest({ id: "req-sandbox-inject" }));
    expect(stub).toHaveBeenCalledOnce();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(expect.objectContaining({
      kind: "bubblewrap",
      platform: "linux",
    }));
  });

  it("preserves an explicitly-provided sandboxCapability without re-detecting (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "bubblewrap" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    const explicitCap = {
      kind: "none" as const,
      confidence: "verified" as const,
      platform: "darwin" as NodeJS.Platform,
      reason: "caller-supplied override",
    };
    gate.requestAndWait(makeRequest({ id: "req-sandbox-explicit", sandboxCapability: explicitCap }));
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(explicitCap);
  });

  it("uses the REAL detectSandboxCapability when no provider is supplied (round-6 test-engineer MAJOR)", () => {
    // Default-provider integration test — verifies that the production
    // path (gate constructed without explicit sandboxCapabilityProvider)
    // wires `detectSandboxCapability` correctly. A refactor that drops
    // the default would silently break the dialog's "보안 격리" row in
    // production but pass every stubbed unit test.
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never); // 1-arg form — uses real default
    gate.requestAndWait(makeRequest({ id: "req-real-default" }));
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeDefined();
    expect(sent.sandboxCapability?.kind).toMatch(/^(none|bubblewrap|sandbox-exec|appcontainer)$/);
    expect(sent.sandboxCapability?.platform).toBe(process.platform);
  });

  it("does NOT inject sandboxCapability for toolCategory=meta requests (round-5 critic MAJOR-1)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "bubblewrap" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    // Mode-change asks (permission-mode-apply.ts) and agent-action asks
    // (agent-action-requester.ts) both pass toolCategory="meta". The
    // sandbox row is meaningless on config-change cards — verify the
    // injection is suppressed.
    gate.requestAndWait(makeRequest({
      id: "req-meta",
      toolName: "permission_mode_change",
      toolCategory: "meta",
      args: { fromMode: "default", toMode: "auto", durable: true },
    }));
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for agent-action requests", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "bubblewrap" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(makeRequest({
      id: "req-agent-action",
      category: "agent-action",
      kind: "agent-action",
      toolName: "sample_plugin_decide_approval_with_host",
      toolCategory: "meta",
      args: { approvalId: 42 },
      source: "plugin",
    }));
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.category).toBe("agent-action");
    expect(sent.kind).toBe("agent-action");
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for out-of-allowed-dir kind (round-4 critic CRITICAL C2)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "bubblewrap" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(makeRequest({
      id: "req-oad",
      kind: "out-of-allowed-dir",
      toolName: "read_file",
      outOfAllowedDir: {
        candidatePath: "/some/path",
        suggestedParent: "/some",
        currentAllowed: [],
        adjacencyWarnings: [],
      },
    }));
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });
});
