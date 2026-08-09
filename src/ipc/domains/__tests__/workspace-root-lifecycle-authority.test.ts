/**
 * ONE workspace-root lifecycle authority — driven from the REAL producer.
 *
 * `ipc/domains/workspace.ts` builds the host's permission-directory lifecycle
 * and publishes it once through `setWorkspaceRootLifecycle`. Every consumer —
 * chat loop, side-chat loop, routine loop, sub-agent child loop, and the
 * plugin-surface executor — resolves it through `getWorkspaceRootLifecycle` at
 * approval time.
 *
 * This suite starts at `registerWorkspaceHandlers` (the producer) and asserts
 * the consumer-visible outcome on a ConversationLoop built the way
 * `SubAgentRunner.buildChildDeps` builds one: a plain deps bag that nobody ever
 * wired the lifecycle into. That surface used to offer the user "allow-always"
 * in the modal and then fail the tool with `workspace lifecycle unavailable`,
 * because the lifecycle was delivered by hand-written per-holder assignments
 * and child loops got none of them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

import { registerWorkspaceHandlers } from "../workspace.js";
import { ConversationLoop } from "../../../engine/conversation-loop.js";
import { makeConversationLoopDeps } from "../../../engine/__tests__/conversation-loop-test-helpers.js";
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../../permissions/sensitive-paths.js";
import { makeMockWebContents } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";

const workspaceDeps = {
  auditLogger: { log: vi.fn() },
  getMainWindow: () => null,
  memoryManager: {
    allowProjectRoot: vi.fn(),
    detachSessionsFromProject: vi.fn(async () => 0),
  },
  conversationLoop: {
    deps: {},
    permissionManager: { prunePathGrantsUnderRoot: async () => [] },
    revokeWorkspaceRoot: () => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }),
  },
  routinesStore: {
    revokeWorkspaceRoot: async () => ({ routinesUpdated: 0, directoriesRemoved: 0 }),
  },
} as never;

/** A child loop's deps: exactly what `buildChildDeps` spreads — no lifecycle. */
function makeSubAgentShapedLoop(gate: ApprovalGate, executeSpy: (input: unknown) => Promise<string>) {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: "read_file",
    description: "Reads a file.",
    source: "builtin",
    category: "read",
    pathFields: ["path"],
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  }));
  return new ConversationLoop(makeConversationLoopDeps({
    toolRegistry: registry,
    approvalGate: gate,
  }));
}

async function firstApprovalPayload<T>(wc: ReturnType<typeof makeMockWebContents>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const payload = wc.send.mock.calls[0]?.[1];
    if (payload) return payload as T;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("approval request was not sent");
}

let home: string;
let grantRoot: string;
let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env.LVIS_HOME;
  home = mkdtempSync(join(tmpdir(), "lvis-wsroot-authority-home-"));
  process.env.LVIS_HOME = home;
  grantRoot = mkdtempSync(join(tmpdir(), "lvis-wsroot-authority-grant-"));
  writeFileSync(join(grantRoot, "notes.md"), "content\n");
  // THE PRODUCER. Nothing else in this file publishes a lifecycle.
  registerWorkspaceHandlers(workspaceDeps);
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = previousHome;
  await cleanupTmpDir(home);
  await cleanupTmpDir(grantRoot);
});

describe("workspace-root lifecycle authority", () => {
  it("registerWorkspaceHandlers reaches a sub-agent-shaped loop: allow-always persists the root", async () => {
    expect(handlers.size).toBeGreaterThan(0);
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executeSpy = vi.fn(async () => "ok");
    const loop = makeSubAgentShapedLoop(gate, executeSpy);

    const callPromise = loop.toolExecutor.executeAll(
      [{
        id: "tu-subagent-allow-always",
        name: "read_file",
        input: { path: join(grantRoot, "notes.md") },
      }],
      {
        sessionId: "sess-subagent-allow-always",
        permissionContext: { trustOrigin: "user-keyboard" },
      },
    );

    const sent = await firstApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      outOfAllowedDir?: { suggestedParent?: string };
    }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-always",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;

    // Consumer-visible: the tool ran, and the durable widening the user
    // consented to actually landed in the persisted allow-list.
    expect(results[0].content).not.toContain("workspace lifecycle unavailable");
    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const persisted = readPermissionSettings().permissions.additionalDirectories
      .map((dir) => caseFoldForMatch(canonicalizePathForMatch(dir)));
    expect(persisted).toContain(caseFoldForMatch(canonicalizePathForMatch(grantRoot)));
  });
});
