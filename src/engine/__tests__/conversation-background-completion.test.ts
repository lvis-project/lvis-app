import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { __resetActiveSandboxCapabilityForTest } from "../../permissions/sandbox-capability.js";
import { ToolRegistry } from "../../tools/registry.js";
import { backgroundShellManager as manager, createBashOutputTool } from "../../tools/shell-tools.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider } from "../llm/types.js";
import { makeConversationLoopDeps, makeConversationLoopSettings } from "./conversation-loop-test-helpers.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const sessions: string[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) manager.disposeSession(session);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  manager._resetForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

describe("conversation background completion delivery", () => {
  it.each(["quiet", "noisy"])("waits for a real %s child and delivers its final output through the executor", async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-background-completion-")));
    roots.push(root);
    const projectRoot = join(root, "project");
    const profile = join(root, "host-home");
    mkdirSync(projectRoot); mkdirSync(profile);
    vi.stubEnv("LVIS_HOME", profile);
    __resetActiveSandboxCapabilityForTest();

    const outputTool = createBashOutputTool();
    const execute = vi.spyOn(outputTool, "execute");
    const registry = new ToolRegistry();
    registry.register(outputTool);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      settingsService: makeConversationLoopSettings(false),
      toolRegistry: registry,
      disableSessionPersistence: true,
      getDefaultProject: () => ({ projectRoot, projectName: "project", isDefault: true }),
      authorizeProject: (path) => path === projectRoot
        ? { projectRoot, projectName: "project", isDefault: true }
        : null,
    }));
    loop.newConversation("main", { projectRoot });
    const sessionId = loop.getSessionId();
    sessions.push(sessionId);

    const child = spawn(process.execPath, ["-e", `
      process.on('message', (message) => {
        if (message === 'finish') {
          process.stdout.write('final stdout\\n');
          process.stderr.write('final stderr\\n');
          process.exitCode = 7;
          process.disconnect();
        } else {
          process.stdout.write(String(message) + '\\n');
        }
      });
      process.send('ready');
    `], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    children.push(child);
    const closed = once(child, "close");
    const shellId = manager.register({ sessionId, command: "controlled child", child, startedAt: new Date().toISOString() });
    await once(child, "message");
    const progress = async (text: string): Promise<void> => {
      const output = once(child.stdout!, "data");
      child.send(text);
      await output;
    };
    if (kind === "noisy") await progress("buffered progress");

    const requests: GenericMessage[][] = [];
    const input = { shellId, waitMs: 30_000, waitFor: "completion" };
    const provider: LLMProvider = {
      vendor: "claude",
      async *streamTurn(params) {
        requests.push(structuredClone(params.messages));
        if (requests.length === 1) {
          yield { type: "tool_call", id: "wait-child", name: "bash_output", input };
          yield { type: "message_complete", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_complete", stopReason: "end_turn" };
        }
      },
    };
    loop.provider = provider;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const onToolEnd = vi.fn();
    const pending = loop.runTurn("Wait for the owned child to finish.", {
      onToolStart: () => { markStarted(); }, onToolEnd,
    }, undefined, { inputOrigin: "user-keyboard" });
    await started;
    if (kind === "noisy") await progress("new progress");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(1);
    expect(onToolEnd).not.toHaveBeenCalled();
    child.send("finish");
    const result = await pending;
    await closed;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await execute.mock.results[0]?.value).toMatchObject({ isError: false });
    expect(result.text).toBe("done");
    expect(requests).toHaveLength(2);
    const delivered = requests[1]?.find((message) => message.role === "tool_result" && message.toolUseId === "wait-child");
    expect(delivered).toMatchObject({ role: "tool_result", toolUseId: "wait-child" });
    expect(delivered).not.toHaveProperty("isError");
    const parsed = JSON.parse(delivered!.content as string);
    expect(parsed).toMatchObject({ shellId, status: "exited", exitCode: 7, signal: null, truncated: false });
    expect(parsed.output).toContain("final stdout\n");
    expect(parsed.output).toContain("final stderr\n");
    if (kind === "noisy") expect(parsed.output).toContain("buffered progress\nnew progress\n");
    expect(result.toolCalls).toEqual([{ name: "bash_output", input, result: delivered!.content }]);
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(manager.read(sessionId, shellId)?.output).toBe("");
  });
});
