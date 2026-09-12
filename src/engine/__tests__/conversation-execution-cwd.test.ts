import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { __resetActiveSandboxCapabilityForTest, setSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeConversationLoopDeps, makeConversationLoopSettings } from "./conversation-loop-test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

describe("conversation shell project context", () => {
  it.skipIf(process.platform === "win32")("runs an omitted-cwd shell in the authorized project and denies a private runtime cwd", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-conversation-cwd-")));
    roots.push(root);
    const projectRoot = join(root, "project");
    const defaultRoot = join(root, "default");
    const requestedRoot = join(root, "requested");
    const lvisHome = join(root, "host-home");
    const privateWorkspace = join(lvisHome, "subscription-runtimes", "workspace");
    for (const path of [projectRoot, defaultRoot, requestedRoot, privateWorkspace]) {
      mkdirSync(path, { recursive: true });
    }
    vi.stubEnv("LVIS_HOME", lvisHome);
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);

    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(bash);
    const turns: StreamEvent[][] = [
      [
        { type: "tool_call", id: "project-pwd", name: "bash", input: { command: "pwd" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "private-pwd", name: "bash", input: { command: "pwd", cwd: privateWorkspace } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ];
    const provider: LLMProvider = {
      vendor: "openai",
      subscriptionRuntime: { kind: "subscription", provider: "codex" },
      async *streamTurn() {
        yield* turns.shift() ?? [];
      },
    };
    const settings = makeConversationLoopSettings(false);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      settingsService: {
        ...settings,
        get: (key) => key === "llm"
          ? { ...settings.get("llm"), activeChatRuntime: provider.subscriptionRuntime }
          : settings.get(key),
      } as typeof settings,
      toolRegistry,
      bashAstValidator: new BashAstValidator({ mode: "deny" }),
      disableSessionPersistence: true,
      getDefaultProject: () => ({ projectRoot: defaultRoot, projectName: "default", isDefault: true }),
      authorizeProject: (path) => path === requestedRoot
        ? { projectRoot, projectName: "project", isDefault: false }
        : null,
    }));
    loop.provider = provider;
    loop.newConversation("main", { projectRoot: requestedRoot });
    // An additional directory grant cannot make host-owned runtime state accessible.
    loop.addSessionAdditionalDirectory(privateWorkspace);

    const result = await loop.runTurn("Report the working directory.", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(loop.getSessionExecutionCwd()).toBe(projectRoot);
    expect(projectRoot).not.toBe(process.cwd());
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ name: "bash", input: { command: "pwd" } });
    expect(result.toolCalls[0]?.result.trim()).toBe(projectRoot);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
    expect(execute.mock.calls[0]?.[1].cwd).toBe(projectRoot);
    const toolResults = loop.getHistory().getMessages().filter((message) => message.role === "tool_result");
    expect(toolResults.find((message) => message.toolUseId === "project-pwd")?.isError).not.toBe(true);
    expect(toolResults.find((message) => message.toolUseId === "private-pwd")).toMatchObject({ isError: true });
    expect(result.toolCalls[1]?.result).toContain("subscription-runtimes");
    expect(result.text).toBe("done");
  });
});
