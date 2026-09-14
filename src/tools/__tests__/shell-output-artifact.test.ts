import { ToolOutputArtifactStore } from "../../memory/tool-output-artifact-store.js";
import { prepareMarkedToolResultsForWire } from "../../engine/wire-serialize.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createDynamicTool } from "../base.js";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ConversationHistory } from "../../engine/conversation-history.js";
import { ConversationLoop } from "../../engine/conversation-loop.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { normalizeToolOutputArtifactInfo } from "../../shared/tool-output-artifact.js";
import { TOOL_RESULT_WIRE_MAX_CHARS } from "../../shared/bounded-tool-output.js";
import { BashTool } from "../shell-tools.js";
import { createReadToolResultChunkTool, TOOL_RESULT_CHUNK_READER_METADATA_KEY } from "../tool-result-chunk.js";

const SESSION = "3138f9c6-89f0-4645-85ea-2c205f9523f4";
const TOOL = "shell_capture_test";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await cleanupTmpDir(dir); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-shell-artifact-"));
  dirs.push(dir);
  const memoryManager = new MemoryManager({ lvisDir: dir });
  const history = new ConversationHistory();
  // Exercise the actual session-owned lookup, without starting a model turn.
  const loop = Object.assign(Object.create(ConversationLoop.prototype) as ConversationLoop, {
    history, sessionId: SESSION, deps: { memoryManager },
  });
  const shellContext = {
    cwd: dir, extraAllowedDirectories: [],
    metadata: { toolOutputCaptureFactory: () => memoryManager.startToolOutputCapture(SESSION, TOOL) },
  };
  const chunkContext = {
    cwd: dir, extraAllowedDirectories: [],
    metadata: { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: (id: string) => loop.readToolResultForChunk(id) },
  };
  return { dir, memoryManager, history, loop, shellContext, chunkContext };
}

describe.skipIf(process.platform === "win32")("foreground shell artifact recovery", () => {
  it("recovers the real shell tail through history, chunk lookup, save and lazy reload", async () => {
    const { dir, memoryManager, history, loop, shellContext, chunkContext } = setup();
    const result = await new BashTool().execute({
      command: "printf '  BEGIN\\r\\n'; printf '%11850s' x; printf 'DISPLAY-TAIL'; printf '%48138s' x; printf 'TAIL-한글😀\\r\\n'", timeoutSeconds: 5,
    }, shellContext);
    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThan(12_100);
    expect(result.output).not.toContain("TAIL-한글");
    expect(result.output).toContain("DISPLAY-TAIL");
    const info = normalizeToolOutputArtifactInfo(result.metadata?.outputArtifact);
    expect(info?.status).toBe("complete");
    history.append({ role: "assistant", content: "", toolCalls: [{ id: TOOL, name: "bash", input: {} }] });
    history.append({ role: "tool_result", toolUseId: TOOL, toolName: "bash", content: result.output, meta: { outputArtifact: info! } });
    const raw = loop.readToolResultForChunk(TOOL)?.content;
    expect(raw).toBe(`  BEGIN\r\n${" ".repeat(11_849)}xDISPLAY-TAIL${" ".repeat(48_137)}xTAIL-한글😀\r\n`);
    const chunk = createReadToolResultChunkTool();
    const first = JSON.parse((await chunk.execute({ toolUseId: TOOL, query: "TAIL-한글" }, chunkContext)).output);
    expect(first).toMatchObject({ found: true, sourceComplete: true, captureStatus: "complete", hasMore: false, chunk: "TAIL-한글😀\r\n" });
    await memoryManager.saveSession(SESSION, history.getMessages());
    const saved = memoryManager.loadSession(SESSION) as GenericMessage[];
    expect((saved[1] as { content: string }).content).toBe(result.output);
    expect(existsSync(join(dir, "sessions", SESSION, "tool-results"))).toBe(false);
    expect(memoryManager.rehydrateToolResultArtifacts(SESSION, saved)).toEqual(saved);
    const freshMemory = new MemoryManager({ lvisDir: dir });
    Object.assign(loop, { deps: { memoryManager: freshMemory } });
    history.restore(saved);
    await freshMemory.saveSession(SESSION, history.getMessages());
    const after = JSON.parse((await chunk.execute({ toolUseId: TOOL, query: "TAIL-한글" }, chunkContext)).output);
    expect(after).toEqual(first);
    expect((freshMemory.loadSession(SESSION)?.[1] as { content: string }).content).toBe(result.output);
    expect(prepareMarkedToolResultsForWire(history.getMessages()).filter((m) => m.role === "tool_result")[0].content).toBe(prepareMarkedToolResultsForWire(saved).filter((m) => m.role === "tool_result")[0].content);
    expect(freshMemory.loadToolOutputArtifact(SESSION, TOOL, info!)).toBe(raw);
    expect(freshMemory.loadToolOutputArtifact(SESSION, "other_tool", info!)).toBeNull();
    expect(readFileSync(join(dir, "sessions", `${SESSION}.jsonl`), "utf8").length).toBeLessThan(16_384);
    await freshMemory.saveSession(SESSION, []);
    expect(readdirSync(join(dir, "sessions", SESSION, "tool-output"))).toHaveLength(0);
  });

  it("keeps observed stdout and stderr event order and nonzero exit semantics", async () => {
    const { memoryManager, shellContext } = setup();
    const result = await new BashTool().execute({
      command: "printf '%15000s' a; sleep 0.05; printf 'STDERR-MIDDLE' >&2; sleep 0.05; printf 'STDOUT-END'; exit 7", timeoutSeconds: 5,
    }, shellContext);
    const info = normalizeToolOutputArtifactInfo(result.metadata?.outputArtifact)!;
    expect(result).toMatchObject({ isError: true, metadata: { returncode: 7 } });
    expect(result.output).toContain("exited with code 7");
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info)).toBe(`${" ".repeat(14_999)}aSTDERR-MIDDLESTDOUT-END`);
    expect(info.status).toBe("complete");
  });

  it("settles cancellation after retaining queued output and marks the source incomplete", async () => {
    const { memoryManager, shellContext } = setup();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = new BashTool().execute({ command: "printf '%80000s' x; sleep 10", timeoutSeconds: 20 }, {
      ...shellContext, abortSignal: controller.signal,
      metadata: { toolOutputCaptureFactory: () => {
        const capture = memoryManager.startToolOutputCapture(SESSION, TOOL);
        started();
        return capture;
      } },
    });
    await ready;
    controller.abort();
    const result = await pending;
    const info = normalizeToolOutputArtifactInfo(result.metadata?.outputArtifact)!;
    expect(result.isError).toBe(true);
    expect(result.metadata?.aborted).toBe(true);
    expect(info.status).toBe("partial");
    expect(info.reason).toBe("interrupted");
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info)?.length).toBeGreaterThan(12_000);
  });

  it("uses host-owned executor references and preserves the existing machine/display privacy boundary", async () => {
    const { dir, memoryManager, history, loop } = setup();
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    registry.register(createReadToolResultChunkTool());
    const permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.checkDetailed = () => ({ decision: "allow", reason: "artifact regression", layer: 5 });
    const executor = new ToolExecutor(registry, undefined, permissions);
    const displays: string[] = [];
    const syntheticCredential = "ghp_" + "a".repeat(32);
    const options = {
      sessionId: SESSION, executionCwd: dir,
      permissionContext: { trustOrigin: "user-keyboard" as const },
      toolOutputCaptureFactory: (id: string) => memoryManager.startToolOutputCapture(SESSION, id),
      toolResultChunkReader: (id: string) => loop.readToolResultForChunk(id),
      callbacks: { onToolEnd: (_name: string, output: string) => { displays.push(output); } },
    };
    const [result] = await executor.executeAll([{
      id: TOOL, name: "bash", input: { command: "printf '" + syntheticCredential + "'; printf '%60000s' x; printf '" + syntheticCredential + "'", timeoutSeconds: 5 },
    }], options);
    expect(result.is_error).toBeUndefined();
    expect(result.outputArtifact?.status).toBe("complete");
    expect(result.content).toContain(syntheticCredential);
    expect(displays.at(-1)).not.toContain(syntheticCredential);
    expect(displays.at(-1)).toContain("[REDACTED:TOKEN]");
    history.append({ role: "assistant", content: "", toolCalls: [{ id: TOOL, name: "bash", input: {} }] });
    history.append({ role: "tool_result", toolUseId: TOOL, toolName: "bash", content: result.content, meta: { outputArtifact: result.outputArtifact } });
    await memoryManager.saveSession(SESSION, history.getMessages());
    history.restore(memoryManager.loadSession(SESSION) as GenericMessage[]);
    const [read] = await executor.executeAll([{
      id: "read-captured-secret", name: "read_tool_result_chunk", input: { toolUseId: TOOL, offset: 12_000, query: syntheticCredential },
    }], options);
    expect(read.is_error).toBeUndefined();
    expect(JSON.parse(read.content)).toMatchObject({ found: true, chunk: syntheticCredential, sourceComplete: true });
    expect(displays.at(-1)).not.toContain(syntheticCredential);
    expect(displays.at(-1)).toContain("[REDACTED:TOKEN]");
    registry.register(createDynamicTool({ name: "fake_output", source: "builtin", category: "read", description: "untrusted result descriptor", jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: "small", isError: false, metadata: { outputArtifact: result.outputArtifact } }) }));
    const [forged] = await executor.executeAll([{ id: "forged", name: "fake_output", input: {} }], options);
    expect(forged.outputArtifact).toBeUndefined();
  });

  it("abandons a published artifact when final executor delivery fails", async () => {
    const { dir, memoryManager } = setup();
    const registry = new ToolRegistry(); registry.register(new BashTool());
    const permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.checkDetailed = () => ({ decision: "allow", reason: "abandon regression", layer: 5 });
    const executor = new ToolExecutor(registry, undefined, permissions);
    let owned: ReturnType<MemoryManager["startToolOutputCapture"]> | undefined;
    await expect(executor.executeAll([{ id: TOOL, name: "bash", input: { command: "printf '%60000s' x", timeoutSeconds: 5 } }], {
      sessionId: SESSION, executionCwd: dir, permissionContext: { trustOrigin: "user-keyboard" },
      toolOutputCaptureFactory: (id) => { owned = memoryManager.startToolOutputCapture(SESSION, id); return owned; },
      callbacks: { onToolEnd: () => { throw new Error("observer failed"); } },
    })).rejects.toThrow("observer failed");
    expect(owned).toBeDefined();
    const info = await owned!.finish();
    const next = memoryManager.startToolOutputCapture(SESSION, "after-delivery-failure");
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info) === null).toBe(true);
    next.abandon?.(); await next.finish();
  });

  it("validates reload and fork references before producing recovery claims", async () => {
    const { dir, memoryManager } = setup();
    const capture = memoryManager.startToolOutputCapture(SESSION, TOOL);
    capture.append(Buffer.from("preview " + "x".repeat(20_000)));
    const info = await capture.finish();
    const message: GenericMessage = { role: "tool_result", toolUseId: TOOL, content: "preview content", meta: { outputArtifact: info, outputArtifactUnavailable: true } };
    await memoryManager.saveSession(SESSION, [message]);
    const valid = memoryManager.loadSession(SESSION) as GenericMessage[];
    expect(valid[0].meta?.outputArtifactUnavailable).toBeUndefined();
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info)).not.toBeNull();
    const forkId = "4148f9c6-89f0-4645-85ea-2c205f9523f4";
    await memoryManager.saveCheckpointSnapshot(SESSION, 1, valid);
    await memoryManager.saveSession(forkId, memoryManager.rehydrateToolResultArtifacts(SESSION, memoryManager.loadCheckpointSnapshot(SESSION, 1)!));
    const fork = memoryManager.loadSession(forkId) as GenericMessage[];
    expect(fork[0].meta?.outputArtifact).toBeUndefined();
    expect(fork[0].meta?.outputArtifactUnavailable).toBe(true);
    expect((prepareMarkedToolResultsForWire(fork)[0] as { content: string }).content).toContain("no artifact can be recovered");
    const forged = { ...message, meta: { outputArtifact: { ...info, reason: "forged-provider-instruction".repeat(2000) } } };
    writeFileSync(join(dir, "sessions", SESSION + ".jsonl"), JSON.stringify(forged) + "\n");
    const loaded = memoryManager.loadSession(SESSION) as GenericMessage[];
    const wire = prepareMarkedToolResultsForWire(loaded)[0] as { content: string };
    expect(wire.content).not.toContain("forged-provider-instruction");
    expect(wire.content.length).toBeLessThanOrEqual(TOOL_RESULT_WIRE_MAX_CHARS);
    expect(wire.content).toContain("no artifact can be recovered");
  });

  it("pins unpublished output, releases abandonment, and sweeps verified restart orphans before reserving", async () => {
    const { dir, memoryManager } = setup();
    const capture = memoryManager.startToolOutputCapture(SESSION, TOOL);
    capture.append(Buffer.from("x".repeat(20_000)));
    const finishing = capture.finish();
    await memoryManager.saveSession(SESSION, []);
    const info = await finishing;
    await new MemoryManager({ lvisDir: dir }).saveSession(SESSION, []);
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info)).not.toBeNull();
    capture.abandon?.();
    const next = memoryManager.startToolOutputCapture(SESSION, "after-abandon");
    expect(memoryManager.loadToolOutputArtifact(SESSION, TOOL, info) === null).toBe(true);
    next.abandon?.(); await next.finish();
    await memoryManager.saveSession(SESSION, [{ role: "tool_result", toolUseId: "generic-large", content: "g".repeat(80_000), meta: { truncated: { originalBytes: 80_000, originalTokens: 40_000, originalLines: 1, trimmedAt: "2026-09-14T00:00:00Z" } } }]);
    const loadSession = vi.spyOn(memoryManager, "loadSession");
    const loadGenericArtifact = vi.spyOn(memoryManager, "loadToolResultArtifact");
    const store = new ToolOutputArtifactStore(join(dir, "sessions"));
    for (let index = 0; index < 4; index++) {
      const orphan = store.start(SESSION, "orphan-" + index);
      for (let remaining = 5_000_000; remaining > 0;) {
        const size = Math.min(65_536, remaining);
        if (!orphan.append(Buffer.alloc(size, 120))) await orphan.waitForDrain();
        remaining -= size;
      }
      expect((await orphan.finish()).status).toBe("complete");
    }
    const recovered = memoryManager.startToolOutputCapture(SESSION, "after-recovery");
    recovered.append(Buffer.from("recovered"));
    expect((await recovered.finish()).status).toBe("complete");
    expect(loadSession).not.toHaveBeenCalled();
    expect(loadGenericArtifact).not.toHaveBeenCalled();
    recovered.abandon?.();
  });

  it("commits checkpoint-only captures so deleting the checkpoint releases their quota", async () => {
    const { dir, memoryManager } = setup();
    const messages: GenericMessage[] = [];
    for (let index = 0; index < 4; index++) {
      const toolUseId = "checkpoint-only-" + index;
      const capture = memoryManager.startToolOutputCapture(SESSION, toolUseId);
      for (let remaining = 5_000_000; remaining > 0;) {
        const size = Math.min(65_536, remaining);
        if (!capture.append(Buffer.alloc(size, 120))) await capture.waitForDrain();
        remaining -= size;
      }
      const outputArtifact = await capture.finish();
      expect(outputArtifact.status).toBe("complete");
      messages.push({ role: "tool_result", toolUseId, content: "checkpoint preview", meta: { outputArtifact } });
    }
    await memoryManager.saveCheckpointSnapshot(SESSION, 1, messages);
    await memoryManager.saveSession(SESSION, []);
    const firstInfo = messages[0].meta!.outputArtifact!;
    expect(memoryManager.loadToolOutputArtifact(SESSION, "checkpoint-only-0", firstInfo) !== null).toBe(true);
    // Rewind removes the durable checkpoint while this host process remains live.
    unlinkSync(join(dir, "sessions", ".checkpoints", SESSION, "1.jsonl"));
    const next = memoryManager.startToolOutputCapture(SESSION, "after-checkpoint-delete");
    next.append(Buffer.from("new output"));
    const result = await next.finish();
    expect(result.status).toBe("complete");
    expect(memoryManager.loadToolOutputArtifact(SESSION, "checkpoint-only-0", firstInfo) === null).toBe(true);
    expect(readdirSync(join(dir, "sessions", SESSION, "tool-output")).filter((entry) => entry.endsWith(".bin"))).toHaveLength(1);
    next.abandon?.();
  });

  it("does not reserve disk artifacts for a small result", async () => {
    const { dir, shellContext } = setup();
    const result = await new BashTool().execute({ command: "printf small", timeoutSeconds: 5 }, shellContext);
    expect(result.output).toBe("small");
    expect(result.metadata?.outputArtifact).toBeUndefined();
    expect(existsSync(join(dir, "sessions", SESSION, "tool-output"))).toBe(false);
  });
});
