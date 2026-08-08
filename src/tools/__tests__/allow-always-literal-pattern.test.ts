/**
 * An "Allow always" grant is derived from a literal name — the resolved
 * filesystem path a file tool reports as its `approvalCacheKey`, or the path
 * the approval card showed as `rememberPattern` — and then stored in a field
 * that is glob-matched. A target whose name genuinely contains `*` or `?`
 * therefore grants every sibling the wildcard happens to match, which is not
 * what the user read before consenting.
 *
 * These drive the real executor: a real `PermissionManager` writing a real
 * `permissions.json`, an approval answered `allow-always`, and the assertion
 * made on the file that lands on disk and on whether a sibling is still asked
 * about afterwards.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";

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
    jsonSchema: { type: "object", properties: { path: { type: "string" } } },
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

  const requestAndWait = vi.fn(async (req: { id: string }) => ({
    requestId: req.id,
    choice: "allow-always" as const,
    ...(opts.rememberPattern === undefined ? {} : { rememberPattern: opts.rememberPattern }),
  }));

  return {
    executor: new ToolExecutor(registry, undefined, permMgr, undefined, { requestAndWait } as never),
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
    [{ id, name: TOOL_NAME, input: { path } }],
    { sessionId: "sess-wildcard", permissionContext: { trustOrigin: "user-keyboard" } },
  );
}

function withTempDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-allow-always-literal-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };
}

describe("allow-always with a non-literal derived pattern", () => {
  it("persists the grant when the derived name is literal", withTempDir(async (dir) => {
    // Positive control. Without it, a guard that refused everything would look
    // identical to a guard that refuses only wildcards.
    const h = harness(dir, {
      approvalCacheKey: () => "path:/work/Reports-2024/notes.md",
    });

    const results = await call(h.executor, "tu-literal", "/work/Reports-2024/notes.md");

    expect(results[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
    expect(h.rules()).toContainEqual(
      expect.objectContaining({ pattern: `${TOOL_NAME}:path:/work/Reports-2024/notes.md`, action: "allow" }),
    );
  }));

  it("refuses to persist an approvalCacheKey carrying a wildcard, and blocks the call", withTempDir(async (dir) => {
    const h = harness(dir, {
      approvalCacheKey: () => "path:/work/Reports*2024/notes.md",
    });

    const results = await call(h.executor, "tu-wildcard-key", "/work/Reports*2024/notes.md");

    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("Reports*2024");
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("leaves a sibling the wildcard would have matched still requiring approval", withTempDir(async (dir) => {
    // The consequence that matters. `Reports*2024` stored as a pattern matches
    // `Reports-secret2024`, so the second call would never reach the user.
    const h = harness(dir, {
      approvalCacheKey: (input) => `path:${(input as { path: string }).path}`,
    });

    await call(h.executor, "tu-consented", "/work/Reports*2024/notes.md");
    const sibling = await call(h.executor, "tu-sibling", "/work/Reports-secret2024/notes.md");

    expect(h.requestAndWait).toHaveBeenCalledTimes(2);
    expect(sibling[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(1);
  }));

  it("refuses a rememberPattern carrying a wildcard when no cache key is derived", withTempDir(async (dir) => {
    // The lower-priority half of the same `??` chain: no `approvalCacheKey`, so
    // the card's own path is what would have been stored.
    const h = harness(dir, { rememberPattern: "/work/Reports?2024" });

    const results = await call(h.executor, "tu-wildcard-remember", "/work/anything");

    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("Reports?2024");
    expect(h.executeSpy).not.toHaveBeenCalled();
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("still persists a plain tool-name grant when neither derivation applies", withTempDir(async (dir) => {
    // Tool names hold no metacharacters, so the ordinary always-grant — the
    // overwhelmingly common case — must be untouched by the guard.
    const h = harness(dir, {});

    const results = await call(h.executor, "tu-toolname", "/work/notes.md");

    expect(results[0].is_error).toBeUndefined();
    expect(h.rules()).toContainEqual(
      expect.objectContaining({ pattern: TOOL_NAME, action: "allow" }),
    );
  }));
});
