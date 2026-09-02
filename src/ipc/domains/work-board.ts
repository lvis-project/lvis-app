/**
 * Work-board domain IPC handlers — the personal board CRUD + lifecycle.
 *
 * Bridges the renderer board panel (and any host-side caller) to the
 * {@link WorkBoardStore} persistence layer. Each `WORK_BOARD.*` store channel
 * maps 1:1 to a store method; the store already returns discriminated `status`
 * envelopes, so the handlers forward those verbatim — no fallback / re-shaping.
 *
 * After every SUCCESSFUL mutating call (add / update / transition / complete /
 * reopen / remove) the handler broadcasts a {@link WORK_BOARD.itemChanged}
 * event to all renderer windows (mirroring how the routines domain fans out
 * its events). The board panel subscribes to this and re-lists, so the view
 * stays live across windows and LLM-tool mutations without polling.
 *
 * Every channel validates the sender frame and audits rejected calls through
 * the shared {@link auditUnauthorized} sink (mirroring the routines domain in
 * `routines.ts`). When the store is absent (boot did not construct it) the handlers
 * return an English kebab-case `{ ok: false, error: "no-store" }` code so the
 * renderer can branch without parsing exceptions.
 *
 * The `run` channel kicks off the WorkBoardEngine plan→approve→execute
 * orchestration for one item. It is fire-and-forget from the renderer's view:
 * the handler broadcasts a `runStarted` marker, awaits the engine result, then
 * broadcasts `runFinished` (any terminal status, incl. denied/not_found) or
 * `runFailed` (engine threw). Live per-phase progress flows over the separate
 * `runProgress` channel, fanned out by the engine's `emitProgress` sink wired
 * at boot. When the engine is absent (boot did not construct it) the handler
 * returns `{ ok: false, error: "no-engine" }`.
 *
 * The `generate-report` channel produces a daily / weekly personal work report
 * from the board state + activity log + learned memory via the host-native
 * {@link WorkBoardReporter}, returning the generated markdown. When the
 * reporter is absent (boot did not construct it) it returns
 * `{ ok: false, error: "no-reporter" }`.
 *
 * The `run-briefing` channel runs the same two windows in the opposite
 * direction: instead of summarizing the board, it drives a read-only sub-agent
 * survey of the user's work and files what it found back as proposals, naming
 * every card it wrote on the `proposalChanged` channel.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { fanOutToAllWindows } from "../window-fanout.js";
import type { IpcDeps } from "../types.js";
import type {
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkItemRunResult,
} from "../../shared/work-board-types.js";
import { errorMessage } from "../../shared/error-message.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { createDirStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import type {
  WorkItemCreateInput,
  WorkItemUpdateInput,
  WorkItemListFilter,
  WorkItemStatusStored,
  WorkItemChangedEventPayload,
  WorkItemGetResult,
  WorkItemResolved,
  WorkProposalChangedEventPayload,
} from "../../main/work-board-store.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";

/** Shared "store not constructed at boot" envelope for the mutating channels. */
const NO_STORE = { ok: false, error: "no-store" as const };
/** Shared "engine not constructed at boot" envelope for the `run` channel. */
const NO_ENGINE = { ok: false, error: "no-engine" as const };
/** Shared "reporter not constructed at boot" envelope for `generate-report`. */
const NO_REPORTER = { ok: false, error: "no-reporter" as const };
const UNAUTHORIZED_PROJECT_ROOT = "__lvis_unauthorized_project_root__";
const PROJECT_NOT_ALLOWED_REASON = "project root is not authorized";

function normalizeProjectListFilter(filter?: WorkItemListFilter): WorkItemListFilter {
  const resolved = resolveAuthorizedWorkspaceProject(filter?.projectRoot);
  if (!resolved.authorized || !resolved.project) {
    return {
      ...filter,
      projectRoot: UNAUTHORIZED_PROJECT_ROOT,
      includeUnscoped: false,
    };
  }
  return {
    ...filter,
    projectRoot: resolved.project.projectRoot,
    includeUnscoped: resolved.project.isDefault === true,
  };
}

function normalizeCreateInputProject(input: WorkItemCreateInput):
  | { ok: true; input: WorkItemCreateInput }
  | { ok: false; result: { status: "invalid"; reason: string } } {
  const resolved = resolveAuthorizedWorkspaceProject(input?.projectRoot, input?.projectName);
  if (!resolved.authorized || !resolved.project) {
    return { ok: false, result: { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON } };
  }
  return {
    ok: true,
    input: {
      ...input,
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    },
  };
}

function isAuthorizedStoredWorkItem(item: WorkItemResolved): boolean {
  if (!item.projectRoot) return true;
  const resolved = resolveAuthorizedWorkspaceProject(item.projectRoot, item.projectName);
  return resolved.authorized && resolved.project !== null;
}

export function registerWorkBoardHandlers(deps: IpcDeps): void {
  const { workBoardStore, workBoardEngine, workBoardReport, auditLogger, getMainWindow, getAppWindows } = deps;

  /**
   * Fan the `itemChanged` event through the curated app-renderer target set.
   * Destroyed windows are skipped. Mirrors `broadcastPromptsUpdated` in the
   * prompts domain.
   */
  const broadcastItemChanged = (
    itemId: number,
    change: WorkItemChangedEventPayload["change"],
  ): void => {
    const payload: WorkItemChangedEventPayload = {
      itemId,
      change,
      changedAt: new Date().toISOString(),
    };
    for (const win of getAppWindows?.() ?? [getMainWindow()]) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send(WORK_BOARD.itemChanged, payload);
    }
  };

  const loadAuthorizedItem = async (id: number): Promise<WorkItemGetResult> => {
    if (!workBoardStore) return { status: "not_found", itemId: id };
    const result = await workBoardStore.get(id);
    if (result.status !== "found") return result;
    return isAuthorizedStoredWorkItem(result.item) ? result : { status: "not_found", itemId: id };
  };

  // ─── List ────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.list, async (e, filter?: WorkItemListFilter) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.list(normalizeProjectListFilter(filter));
  });

  // ─── Get ─────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.get, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.get, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return loadAuthorizedItem(id);
  });

  // ─── Add ─────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.add, async (e, input: WorkItemCreateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.add, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const normalized = normalizeCreateInputProject(input);
    if (!normalized.ok) return normalized.result;
    const result = await workBoardStore.create(normalized.input);
    if (result.status === "created") broadcastItemChanged(result.itemId, "created");
    return result;
  });

  // ─── Update ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.update, async (e, id: number, patch: WorkItemUpdateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.update, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.update(id, patch);
    if (result.status === "updated") broadcastItemChanged(result.itemId, "updated");
    return result;
  });

  // ─── Transition ──────────────────────────────────
  ipcMain.handle(WORK_BOARD.transition, async (e, id: number, to: WorkItemStatusStored) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.transition, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.transition(id, to);
    if (result.status === "transitioned") broadcastItemChanged(result.itemId, "transitioned");
    return result;
  });

  // ─── Complete ────────────────────────────────────
  ipcMain.handle(WORK_BOARD.complete, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.complete, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.complete(id);
    if (result.status === "completed") broadcastItemChanged(result.itemId, "completed");
    return result;
  });

  // ─── Reopen ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.reopen, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.reopen, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.reopen(id);
    if (result.status === "reopened") broadcastItemChanged(result.itemId, "reopened");
    return result;
  });

  // ─── Remove ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.remove, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.remove(id);
    if (result.status === "deleted") broadcastItemChanged(result.itemId, "removed");
    return result;
  });

  // ─── Run (plan → approve → execute) ──────────────
  // Renderer → main: kick off the engine run for one item. The renderer awaits
  // the terminal WorkItemRunResult, but also subscribes to the runProgress /
  // runStarted / runFinished / runFailed broadcasts for live phase updates. The
  // engine itself drives runProgress (per-phase) via its emitProgress sink; this
  // handler owns only the coarse started/finished/failed markers so every window
  // can show/clear a per-item running indicator without re-listing.
  ipcMain.handle(WORK_BOARD.run, async (e, id: number, opts?: { agentName?: string }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!workBoardStore) return { status: "error", reason: "no-store" } satisfies WorkItemRunResult;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return { status: "not_found" } satisfies WorkItemRunResult;

    const windows = (): Array<import("electron").BrowserWindow | null | undefined> =>
      getAppWindows?.() ?? [getMainWindow()];

    fanOutToAllWindows(windows(), WORK_BOARD.runStarted, {
      itemId: id,
      at: new Date().toISOString(),
    });
    try {
      const result: WorkItemRunResult = await workBoardEngine.runItem(
        id,
        opts?.agentName ? { agentName: opts.agentName } : undefined,
      );
      fanOutToAllWindows(windows(), WORK_BOARD.runFinished, {
        itemId: id,
        status: result.status,
        at: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const reason = errorMessage(err);
      fanOutToAllWindows(windows(), WORK_BOARD.runFailed, {
        itemId: id,
        reason,
        at: new Date().toISOString(),
      });
      // Surface as the engine's `error` envelope so the renderer branches on one
      // shape — no thrown exception crossing the IPC boundary.
      return { status: "error", reason } satisfies WorkItemRunResult;
    }
  });

  // ─── Generate report (daily | weekly) ───────────
  // Renderer → main: build a personal work report. The reporter returns a
  // discriminated `{ status: "ok" | "empty" }` envelope (forwarded verbatim).
  // An LLM provider outage surfaces as a thrown error → mapped to an `error`
  // envelope so the renderer branches on one shape, never a raw exception.
  ipcMain.handle(
    WORK_BOARD.generateReport,
    async (
      e,
      kind: "daily" | "weekly",
      input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.generateReport, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardReport) return NO_REPORTER;
      try {
        return await workBoardReport.generate(kind === "weekly" ? "weekly" : "daily", normalizeProjectListFilter(input));
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error" as const, kind, reason };
      }
    },
  );

  // ─── Run transcript (past run conversation) ──────
  // Renderer → main: read a past run's persisted plan+execute conversation for
  // the run-history view. Returns `{ events }` (empty when the file is absent).
  ipcMain.handle(WORK_BOARD.runTranscript, async (e, itemId: number, runId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.runTranscript, e);
      return UNAUTHORIZED_FRAME;
    }
    // The renderer-supplied runId is interpolated into the transcript file path
    // (sessions/<itemId>/<runId>.jsonl), so validate it against path traversal
    // BEFORE the read — engine run ids are UUIDs. Anything else → empty.
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return { events: [] };
    if (!workBoardStore) return { events: [] };
    const existing = await loadAuthorizedItem(itemId);
    if (existing.status !== "found") return { events: [] };
    const storage = createDirStorage(openFeatureNamespace("work-board").dir);
    return { events: await readRunTranscript(storage, itemId, runId) };
  });

  // ─── Recommended work (plugin-proposed cards) ────
  // Plugins post and withdraw through HostApi (main-side); the renderer only
  // READS the open set and answers it — accept, which promotes the proposal
  // into an ordinary work item, or dismiss, which closes the card for good.
  // There is deliberately no renderer write path that creates a proposal: a
  // proposal is a plugin's claim, and the user's own additions are work items.

  const broadcastProposalChanged = (
    proposalId: string,
    change: WorkProposalChangedEventPayload["change"],
  ): void => {
    const payload: WorkProposalChangedEventPayload = {
      proposalId,
      change,
      changedAt: new Date().toISOString(),
    };
    for (const win of getAppWindows?.() ?? [getMainWindow()]) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send(WORK_BOARD.proposalChanged, payload);
    }
  };

  ipcMain.handle(WORK_BOARD.listProposals, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.listProposals, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.listProposals();
  });

  // Accept runs the ORDINARY create path, so the new item lands in the active
  // project exactly as a hand-typed one does. Proposals themselves are not
  // project-scoped — a plugin watching a mailbox has no project — so the
  // project is decided here, at accept time, from the renderer's own workspace.
  ipcMain.handle(WORK_BOARD.acceptProposal, async (e, proposalId: string, projectRoot?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.acceptProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    if (typeof proposalId !== "string" || proposalId.length === 0) {
      return { status: "invalid", reason: "proposalId is required" };
    }
    const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
    if (!resolved.authorized || !resolved.project) {
      return { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON };
    }
    const result = await workBoardStore.acceptProposal(proposalId, {
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    });
    if (result.status === "accepted") {
      broadcastItemChanged(result.itemId, "created");
      broadcastProposalChanged(proposalId, "accepted");
    }
    return result;
  });

  ipcMain.handle(WORK_BOARD.dismissProposal, async (e, proposalId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.dismissProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.dismissProposal(proposalId);
    if (result.status === "dismissed") broadcastProposalChanged(proposalId, "dismissed");
    return result;
  });

  // ─── Run briefing (survey → proposals) ───────────
  // Renderer → main: run the daily / weekly briefing. The engine surveys the
  // user's work with a read-only sub-agent and files what it found as
  // proposals — the opposite direction from `generate-report`, which
  // summarizes what the board already holds. Registered here, after
  // `broadcastProposalChanged`, because every card the briefing writes is
  // announced on that same channel so each window re-lists without polling.
  ipcMain.handle(
    WORK_BOARD.runBriefing,
    async (e, kind: WorkBoardBriefingKind, projectRoot?: string) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.runBriefing, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardEngine) return NO_ENGINE;
      const briefingKind: WorkBoardBriefingKind = kind === "weekly" ? "weekly" : "daily";
      const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
      if (!resolved.authorized || !resolved.project) {
        return {
          status: "error",
          kind: briefingKind,
          reason: PROJECT_NOT_ALLOWED_REASON,
        } satisfies WorkBoardBriefingResult;
      }
      try {
        const result = await workBoardEngine.runBriefing(briefingKind, {
          projectRoot: resolved.project.projectRoot,
          includeUnscoped: resolved.project.isDefault === true,
        });
        if (result.status === "ok") {
          for (const id of [...result.filed, ...result.refreshed]) {
            broadcastProposalChanged(id, "posted");
          }
        }
        return result;
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error", kind: briefingKind, reason } satisfies WorkBoardBriefingResult;
      }
    },
  );
}
