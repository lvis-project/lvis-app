/**
 * "Allow always" is an exact Store-B decision, keyed by the canonical
 * (tool, args, source, trustOrigin, approvalCacheKey) tuple. Cache keys and
 * legacy `rememberPattern` values must never become glob-matched Store-A
 * rules: a literal `*` or `?` in a user-approved target is data, not syntax
 * that widens the grant to siblings.
 *
 * These drive the real executor plus the real user-approval store. The gate
 * fixture models ToolApprovalContent's production ordering by recording the
 * exact persistent tuple before resolving `allow-always`.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  __resetSessionStoreForTest,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";

const TOOL_NAME = "wildcard_probe";

interface Harness {
  executor: ToolExecutor;
  executeSpy: ReturnType<typeof vi.fn>;
  requestAndWait: ReturnType<typeof vi.fn>;
  rules: () => { pattern: string; action: string }[];
}

/**
 * @param approvalCacheKey - what the tool reports as the identity of this
 *   call. The file tools return `path:<resolved path>` here, so this is the
 *   real shape of the higher-priority derivation.
 * @param rememberPattern - what the approval card sends back on "always".
 */
function harness(
  dir: string,
  auditLogger: AuditLogger,
  opts: {
    approvalCacheKey?: (input: unknown) => string;
    rememberPattern?: string;
  },
): Harness {
  const executeSpy = vi.fn(async () => "sent");
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: TOOL_NAME,
    description: "probe requiring approval",
    source: "plugin",
    pluginId: "test-plugin",
    category: "network",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" },
      },
    },
    ...(opts.approvalCacheKey ? { approvalCacheKey: opts.approvalCacheKey } : {}),
    execute: async () => ({ output: await executeSpy(), isError: false }),
  }));

  const permissionsFile = join(dir, "permissions.json");
  const permMgr = new PermissionManager(permissionsFile);
  permMgr.setMode("auto");
  permMgr.setInteractiveAutoApprove("low");
  // A non-LOW verdict is what routes the call to the approval modal instead of
  // auto-approving it, which is the only lane that persists an always-grant.
  permMgr.setReviewer({
    classifier: { classify: vi.fn(() => ({ level: "medium" as const, reason: "needs confirmation" })) },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
  });

  const requestAndWait = vi.fn(async (req: ApprovalRequestInput) => {
    // Production ToolApprovalContent awaits this exact persistent record before
    // resolving the gate. A gate-only unit double must model that renderer
    // side-effect or the next call correctly has nothing to remember.
    await recordApproval(
      req.toolName,
      canonicalStringify(req.args ?? {}),
      req.source ?? "builtin",
      {
        decision: "allow",
        scope: "persistent",
        verdictAtApproval: req.reviewerVerdict?.level ?? "low",
        nlJustification: null,
        trustOrigin: req.trustOrigin,
        approvalCacheKey: req.approvalCacheKey,
      },
    );
    return {
      requestId: req.id,
      choice: "allow-always" as const,
      ...(opts.rememberPattern === undefined ? {} : { rememberPattern: opts.rememberPattern }),
    };
  });

  return {
    executor: new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      auditLogger,
    ),
    executeSpy,
    requestAndWait,
    rules: () => {
      try {
        return JSON.parse(readFileSync(permissionsFile, "utf-8")).rules ?? [];
      } catch {
        return [];
      }
    },
  };
}

function call(executor: ToolExecutor, id: string, path: string) {
  return executor.executeAll(
    // Keep the network target deterministically LOW so the test isolates exact
    // identity instead of exercising the independent risk-escalation guard.
    [{ id, name: TOOL_NAME, input: { path, url: "https://api.openai.com" } }],
    { sessionId: "sess-wildcard", permissionContext: { trustOrigin: "user-keyboard" } },
  );
}

function withTempDir(
  run: (dir: string, auditLogger: AuditLogger) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-allow-always-literal-"));
    const previousLvisHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = dir;
    __resetSessionStoreForTest();
    const auditLogger = new AuditLogger(join(dir, "audit"));
    try {
      await run(dir, auditLogger);
    } finally {
      await auditLogger.close();
      if (previousLvisHome === undefined) delete process.env.LVIS_HOME;
      else process.env.LVIS_HOME = previousLvisHome;
      __resetSessionStoreForTest();
      await cleanupTmpDir(dir);
    }
  };
}

describe("allow-always exact identity", () => {
  it("records and recalls the exact tuple when the cache key is literal", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: () => "path:/work/Reports-2024/notes.md",
    });

    const first = await call(h.executor, "tu-literal-1", "/work/Reports-2024/notes.md");
    const second = await call(h.executor, "tu-literal-2", "/work/Reports-2024/notes.md");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("treats a wildcard-bearing cache key as opaque exact data", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: () => "path:/work/Reports*2024/notes.md",
    });

    const first = await call(h.executor, "tu-wildcard-key-1", "/work/Reports*2024/notes.md");
    const second = await call(h.executor, "tu-wildcard-key-2", "/work/Reports*2024/notes.md");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("leaves a sibling the wildcard would have matched still requiring approval", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: (input) => `path:${(input as { path: string }).path}`,
    });

    await call(h.executor, "tu-consented", "/work/Reports*2024/notes.md");
    const sibling = await call(h.executor, "tu-sibling", "/work/Reports-secret2024/notes.md");

    expect(h.requestAndWait).toHaveBeenCalledTimes(2);
    expect(sibling[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("ignores a legacy wildcard rememberPattern instead of turning it into a glob rule", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, { rememberPattern: "/work/Reports?2024" });

    const first = await call(h.executor, "tu-wildcard-remember-1", "/work/anything");
    const second = await call(h.executor, "tu-wildcard-remember-2", "/work/anything");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("does not widen a no-cache-key approval into a tool-wide grant", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {});

    const first = await call(h.executor, "tu-toolname-1", "/work/notes.md");
    const same = await call(h.executor, "tu-toolname-2", "/work/notes.md");
    const different = await call(h.executor, "tu-toolname-3", "/work/other.md");

    expect(first[0].is_error).toBeUndefined();
    expect(same[0].is_error).toBeUndefined();
    expect(different[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(3);
    expect(h.requestAndWait).toHaveBeenCalledTimes(2);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));
});
