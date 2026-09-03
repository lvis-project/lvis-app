/**
 * `lvis:home-docs:*` — applying, keeping, and merging a packaged doc update.
 *
 * The suite runs against a real temp `~/.lvis` and real upgrade markers, so
 * what a marker IS stays decided by the seeder's own grammar rather than by a
 * fixture that agrees with it today. Only the reviewer is a stub: what the
 * model returns is not what these handlers decide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeAppIpcHandler } from "./test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

let home: string;
const prevLvisHome = process.env.LVIS_HOME;

/** A reviewer that answers with fixed text, so the handler is what is measured. */
function stubReviewer(answer = "MERGED DOC\n") {
  return {
    review: vi.fn(async (_task: string, _prompt: string, _options?: unknown) => answer),
  };
}

async function setup(options: {
  keepLatest?: boolean;
  agentsMd?: string;
  agentsCustomMd?: string;
  reviewerAnswer?: string;
  withMergeService?: boolean;
} = {}) {
  handlers.clear();
  vi.clearAllMocks();

  const { MemoryManager } = await import("../../../memory/memory-manager.js");
  const { AgentsDocMergeService } = await import("../../../memory/agents-doc-merge-service.js");
  const { registerHomeDocsHandlers } = await import("../home-docs.js");

  if (options.agentsMd !== undefined) {
    writeFileSync(join(home, "AGENTS.md"), options.agentsMd);
  }
  if (options.agentsCustomMd !== undefined) {
    writeFileSync(join(home, "agents.custom.md"), options.agentsCustomMd);
  }

  const memoryManager = new MemoryManager({ lvisDir: home });
  memoryManager.load();
  const memoryReviewer = stubReviewer(options.reviewerAnswer);
  const agentsDocMergeService = new AgentsDocMergeService({ memoryManager, memoryReviewer });
  const auditLogger = { log: vi.fn() };

  registerHomeDocsHandlers({
    auditLogger,
    memoryManager,
    settingsService: { get: () => ({ keepLatest: options.keepLatest ?? false }) },
    ...(options.withMergeService === false ? {} : { agentsDocMergeService }),
    getMainWindow: () => null,
  } as never);

  return { memoryManager, memoryReviewer, auditLogger, agentsDocMergeService };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lvis-home-docs-"));
  process.env.LVIS_HOME = home;
});

afterEach(async () => {
  await cleanupTmpDir(home);
  if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevLvisHome;
});

describe("home-docs — listing and reading markers", () => {
  it("re-scans the directory instead of answering from a boot snapshot", async () => {
    await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    const status = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.upgradeMarkersList,
    ) as { markers: Array<{ markerPath: string; actionable: boolean }> };

    expect(status.markers.map((m) => m.markerPath)).toEqual(["AGENTS.md.new"]);
    expect(status.markers[0].actionable).toBe(true);
  });

  it("lists a skill marker but wires no action to it", async () => {
    await setup({ agentsMd: "mine\n" });
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "report.md.new"), "skill v2\n");

    const status = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.upgradeMarkersList,
    ) as { markers: Array<{ markerPath: string; actionable: boolean }> };

    expect(status.markers).toHaveLength(1);
    expect(status.markers[0].actionable).toBe(false);
    // Listed is not actionable: applying one is a different decision.
    expect(
      await invokeAppIpcHandler(
        handlers,
        CHANNELS.homeDocs.packagedApply,
        status.markers[0].markerPath,
      ),
    ).toEqual({ ok: false, error: "unsupported-upgrade-target" });
  });

  it("reads a marker together with the live doc it would replace", async () => {
    await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    const result = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.markerRead,
      "AGENTS.md.new",
    );

    expect(result).toEqual({ ok: true, content: "packaged v2\n", live: "mine\n" });
  });

  it("refuses a path that is not a listed marker", async () => {
    await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "secret.txt"), "private\n");

    for (const path of ["../secret.txt", "secret.txt", "/etc/hosts", "AGENTS.md"]) {
      expect(
        await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.markerRead, path),
      ).toEqual({ ok: false, error: "unknown-upgrade-marker" });
    }
  });
});

describe("home-docs — applying a packaged version", () => {
  it("replaces the live doc and retires every marker carrying those bytes", async () => {
    await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-01-01"), "packaged v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-02-01"), "packaged v3\n");

    const result = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.packagedApply,
      "AGENTS.md.new",
    );

    expect(result).toEqual({ ok: true, movedToCustom: false });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("packaged v2\n");
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
    expect(existsSync(join(home, "AGENTS.md.new.2026-01-01"))).toBe(false);
    // A genuinely different version is still an open offer.
    expect(existsSync(join(home, "AGENTS.md.new.2026-02-01"))).toBe(true);
  });

  it("moves the user's content to agents.custom.md under keep-latest", async () => {
    const { memoryManager } = await setup({ keepLatest: true, agentsMd: "my rules\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    const result = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.packagedApply,
      "AGENTS.md.new",
    );

    expect(result).toEqual({ ok: true, movedToCustom: true });
    expect(readFileSync(join(home, "agents.custom.md"), "utf8")).toBe("my rules\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("packaged v2\n");
    expect(memoryManager.getAgentsCustomMd()).toBe("my rules\n");
    expect(memoryManager.getAgentsMd()).toBe("packaged v2\n");
  });

  it("does not split out an empty live doc as if it were the user's content", async () => {
    await setup({ keepLatest: true, agentsMd: "" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    const result = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.packagedApply,
      "AGENTS.md.new",
    );

    expect(result).toEqual({ ok: true, movedToCustom: false });
    expect(existsSync(join(home, "agents.custom.md"))).toBe(false);
  });

  it("audits the apply", async () => {
    const { auditLogger } = await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.packagedApply, "AGENTS.md.new");

    const entry = auditLogger.log.mock.calls[0][0] as { type: string; input: string };
    expect(entry.type).toBe("info");
    expect(JSON.parse(entry.input)).toMatchObject({
      action: "apply-packaged",
      markerPath: "AGENTS.md.new",
    });
  });
});

describe("home-docs — keeping the user's version", () => {
  it("removes just the named marker", async () => {
    await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-02-01"), "packaged v3\n");

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.markerKeepMine, "AGENTS.md.new"),
    ).toEqual({ ok: true });
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
    expect(existsSync(join(home, "AGENTS.md.new.2026-02-01"))).toBe(true);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("mine\n");
  });
});

describe("home-docs — the model-assisted merge", () => {
  it("writes the merge to AGENTS.md.merged and never over the live doc", async () => {
    const { memoryReviewer } = await setup({
      agentsMd: "mine\n",
      reviewerAnswer: "merged doc\n",
    });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");

    const result = await invokeAppIpcHandler(
      handlers,
      CHANNELS.homeDocs.mergeRun,
      "AGENTS.md.new",
    ) as { ok: true; content: string };

    expect(result.ok).toBe(true);
    expect(result.content).toBe("merged doc\n");
    expect(readFileSync(join(home, "AGENTS.md.merged"), "utf8")).toBe("merged doc\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("mine\n");
    expect(memoryReviewer.review).toHaveBeenCalledOnce();
    const [task, prompt] = memoryReviewer.review.mock.calls[0];
    expect(task).toBe("merge");
    expect(prompt).toContain("untrusted reference data");
    expect(prompt).toContain("mine");
    expect(prompt).toContain("packaged v2");
  });

  it("merges the custom half against the live packaged doc under keep-latest", async () => {
    const { memoryReviewer } = await setup({
      keepLatest: true,
      agentsMd: "packaged v2\n",
      agentsCustomMd: "my rules\n",
    });

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, undefined),
    ).toMatchObject({ ok: true });
    const prompt = memoryReviewer.review.mock.calls[0][1];
    expect(prompt).toContain("my rules");
    expect(prompt).toContain("packaged v2");
  });

  it("refuses when there is nothing on the user's side to preserve", async () => {
    await setup({ keepLatest: true, agentsMd: "packaged v2\n" });

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, undefined),
    ).toEqual({ ok: false, error: "nothing-to-merge" });
  });

  it("applies the merge over the live doc only while it is unchanged", async () => {
    await setup({ agentsMd: "mine\n", reviewerAnswer: "merged doc\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");
    await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, "AGENTS.md.new");

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeApply, "mine\n"),
    ).toEqual({ ok: true });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("merged doc\n");
    expect(existsSync(join(home, "AGENTS.md.merged"))).toBe(false);
  });

  it("reports a conflict rather than overwriting an edit made during the merge", async () => {
    await setup({ agentsMd: "mine\n", reviewerAnswer: "merged doc\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");
    await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, "AGENTS.md.new");
    writeFileSync(join(home, "AGENTS.md"), "edited while merging\n");

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeApply, "mine\n"),
    ).toEqual({ ok: false, error: "agents-doc-changed" });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("edited while merging\n");
    expect(existsSync(join(home, "AGENTS.md.merged"))).toBe(true);
  });

  it("applies the merge to the custom half under keep-latest", async () => {
    await setup({
      keepLatest: true,
      agentsMd: "packaged v2\n",
      agentsCustomMd: "my rules\n",
      reviewerAnswer: "merged custom\n",
    });
    await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, undefined);

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeApply, "my rules\n"),
    ).toEqual({ ok: true });
    expect(readFileSync(join(home, "agents.custom.md"), "utf8")).toBe("merged custom\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("packaged v2\n");
  });

  it("discards the artifact without touching either doc", async () => {
    await setup({ agentsMd: "mine\n", reviewerAnswer: "merged doc\n" });
    writeFileSync(join(home, "AGENTS.md.new"), "packaged v2\n");
    await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, "AGENTS.md.new");

    expect(await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeDiscard)).toEqual({ ok: true });
    expect(existsSync(join(home, "AGENTS.md.merged"))).toBe(false);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  it("answers merge requests with a stable code when no merge service is composed", async () => {
    await setup({ agentsMd: "mine\n", withMergeService: false });

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.mergeRun, undefined),
    ).toEqual({ ok: false, error: "agents-doc-merge-unavailable" });
  });
});

describe("home-docs — the user's own half", () => {
  it("reads and writes agents.custom.md", async () => {
    const { memoryManager } = await setup({ agentsMd: "mine\n" });

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.customUpdate, "my rules\n"),
    ).toEqual({ ok: true });
    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.customGet),
    ).toBe("my rules\n");
    expect(memoryManager.getAgentsCustomMd()).toBe("my rules\n");
  });

  it("refuses a non-string body", async () => {
    await setup({ agentsMd: "mine\n" });

    expect(
      await invokeAppIpcHandler(handlers, CHANNELS.homeDocs.customUpdate, 42),
    ).toEqual({ ok: false, error: "invalid-content" });
  });
});

describe("home-docs — how the compare-and-set write lands on disk", () => {
  it("refuses when the doc changed under it and leaves the file byte-identical", async () => {
    const { memoryManager } = await setup({ agentsMd: "mine\n" });
    writeFileSync(join(home, "AGENTS.md"), "edited elsewhere\n");

    expect(await memoryManager.updateAgentsMdIfUnchanged("mine\n", "merged\n")).toBe(false);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("edited elsewhere\n");
  });

  it("writes when the doc still matches what the caller read", async () => {
    const { memoryManager } = await setup({ agentsMd: "mine\n" });

    expect(await memoryManager.updateAgentsMdIfUnchanged("mine\n", "merged\n")).toBe(true);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("merged\n");
  });

  it.skipIf(process.platform === "win32")(
    "creates agents.custom.md at the private file mode",
    async () => {
      const { memoryManager } = await setup({ agentsMd: "mine\n" });
      expect(existsSync(join(home, "agents.custom.md"))).toBe(false);

      expect(await memoryManager.updateAgentsCustomMdIfUnchanged("", "my rules\n")).toBe(true);
      expect(statSync(join(home, "agents.custom.md")).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a symlinked doc instead of writing through it",
    async () => {
      const outside = join(home, "outside.md");
      writeFileSync(outside, "mine\n");
      symlinkSync(outside, join(home, "AGENTS.md"));
      const { memoryManager } = await setup();

      expect(await memoryManager.updateAgentsMdIfUnchanged("mine\n", "merged\n")).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("mine\n");
      expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("merged\n");
    },
  );
});
