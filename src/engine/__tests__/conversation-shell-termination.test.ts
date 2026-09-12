import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { __resetActiveSandboxCapabilityForTest } from "../../permissions/sandbox-capability.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { makeConversationLoopDeps, makeConversationLoopSettings } from "./conversation-loop-test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

describe.skipIf(process.platform === "win32")("conversation shell termination delivery", () => {
  it.each([
    ["exit 7", "Shell command exited with code 7 without output."],
    ["printf failed; exit 7", "Shell command exited with code 7.\nfailed"],
  ])("delivers the exit reason from %s without serializing execution metadata", async (command, expected) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-shell-termination-")));
    roots.push(root);
    const projectRoot = join(root, "project");
    const profile = join(root, "host-home");
    mkdirSync(projectRoot);
    mkdirSync(profile);
    vi.stubEnv("LVIS_HOME", profile);
    __resetActiveSandboxCapabilityForTest();

    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    const registry = new ToolRegistry();
    registry.register(bash);
    const requests: GenericMessage[][] = [];
    const turns: StreamEvent[][] = [
      [
        { type: "tool_call", id: "shell-exit", name: "bash", input: { command } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ];
    const provider: LLMProvider = {
      vendor: "claude",
      async *streamTurn(params) {
        requests.push(structuredClone(params.messages));
        yield* turns.shift() ?? [];
      },
    };
    const loop = new ConversationLoop(makeConversationLoopDeps({
      settingsService: makeConversationLoopSettings(false),
      toolRegistry: registry,
      bashAstValidator: new BashAstValidator({ mode: "deny" }),
      disableSessionPersistence: true,
      getDefaultProject: () => ({ projectRoot, projectName: "project", isDefault: true }),
      authorizeProject: (path) => path === projectRoot
        ? { projectRoot, projectName: "project", isDefault: true }
        : null,
    }));
    loop.provider = provider;
    loop.newConversation("main", { projectRoot });
    const onToolEnd = vi.fn();

    const result = await loop.runTurn(
      "Run the shell command and report its result.",
      { onToolEnd },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await execute.mock.results[0]?.value).toMatchObject({
      isError: true,
      metadata: { returncode: 7 },
    });
    expect(onToolEnd.mock.calls[0]?.slice(0, 3)).toEqual(["bash", expected, true]);
    expect(result.toolCalls).toEqual([{ name: "bash", input: { command }, result: expected }]);
    expect(requests).toHaveLength(2);
    for (const messages of [loop.getHistory().getMessages(), requests[1] ?? []]) {
      const delivered = messages.find((message) => message.role === "tool_result" && message.toolUseId === "shell-exit");
      expect(delivered).toMatchObject({ role: "tool_result", content: expected, isError: true });
      expect(delivered).not.toHaveProperty("metadata");
      expect(JSON.stringify(delivered)).not.toContain('"returncode"');
    }
    expect(result.text).toBe("done");
  });
});
