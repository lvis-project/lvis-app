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
 * event to all renderer windows (mirroring how the routines v2 domain fans out
 * its events). The board panel subscribes to this and re-lists, so the view
 * stays live across windows and LLM-tool mutations without polling.
 *
 * Every channel validates the sender frame and audits rejected calls through
 * the shared {@link auditUnauthorized} sink (mirroring the routines v2 domain in
 * `misc.ts`). When the store is absent (boot did not construct it) the handlers
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
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { fanOutToAllWindows } from "../broadcast-helpers.js";
import type { IpcDeps } from "../types.js";
import type { WorkItemRunResult } from "../../shared/work-board-types.js";
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
} from "../../main/work-board-store.js";

/** Shared "store not constructed at boot" envelope for the mutating channels. */
const NO_STORE = { ok: false, error: "no-store" as const };
/** Shared "engine not constructed at boot" envelope for the `run` channel. */
const NO_ENGINE = { ok: false, error: "no-engine" as const };
/** Shared "reporter not constructed at boot" envelope for `generate-report`. */
const NO_REPORTER = { ok: false, error: "no-reporter" as const };

export function registerWorkBoardHandlers(deps: IpcDeps): void {
  const { workBoardStore, workBoardEngine, workBoardReport, auditLogger, getMainWindow, getAppWindows } = deps;

  /**
   * Fan the `itemChanged` event out to every renderer window so detached
   * panels and other windows refresh in lock-step. Destroyed windows are
   * skipped. Mirrors `broadcastPromptsUpdated` in the prompts domain.
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

  // ─── List ────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.list, async (e, filter?: WorkItemListFilter) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.list(filter);
  });

  // ─── Get ─────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.get, async (e, id: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.get, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.get(id);
  });

  // ─── Add ─────────────────────────────────────────
  ipcMain.handle(WORK_BOARD.add, async (e, input: WorkItemCreateInput) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.add, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.create(input);
    if (result.status === "created") broadcastItemChanged(result.itemId, "created");
    return result;
  });

  // ─── Update ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.update, async (e, id: number, patch: WorkItemUpdateInput) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.update, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.update(id, patch);
    if (result.status === "updated") broadcastItemChanged(result.itemId, "updated");
    return result;
  });

  // ─── Transition ──────────────────────────────────
  ipcMain.handle(WORK_BOARD.transition, async (e, id: number, to: WorkItemStatusStored) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.transition, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.transition(id, to);
    if (result.status === "transitioned") broadcastItemChanged(result.itemId, "transitioned");
    return result;
  });

  // ─── Complete ────────────────────────────────────
  ipcMain.handle(WORK_BOARD.complete, async (e, id: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.complete, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.complete(id);
    if (result.status === "completed") broadcastItemChanged(result.itemId, "completed");
    return result;
  });

  // ─── Reopen ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.reopen, async (e, id: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.reopen, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const result = await workBoardStore.reopen(id);
    if (result.status === "reopened") broadcastItemChanged(result.itemId, "reopened");
    return result;
  });

  // ─── Remove ──────────────────────────────────────
  ipcMain.handle(WORK_BOARD.remove, async (e, id: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
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
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;

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
      const reason = err instanceof Error ? err.message : String(err);
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
      input?: { date?: string; weekIso?: string; weekOffset?: number },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.generateReport, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardReport) return NO_REPORTER;
      try {
        return await workBoardReport.generate(kind === "weekly" ? "weekly" : "daily", input);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { status: "error" as const, kind, reason };
      }
    },
  );

  // ─── Run transcript (past run conversation) ──────
  // Renderer → main: read a past run's persisted plan+execute conversation for
  // the run-history view. Returns `{ events }` (empty when the file is absent).
  ipcMain.handle(WORK_BOARD.runTranscript, async (e, itemId: number, runId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.runTranscript, e);
      return UNAUTHORIZED_FRAME;
    }
    // The renderer-supplied runId is interpolated into the transcript file path
    // (sessions/<itemId>/<runId>.jsonl), so validate it against path traversal
    // BEFORE the read — engine run ids are UUIDs. Anything else → empty.
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return { events: [] };
    const storage = createDirStorage(openFeatureNamespace("work-board").dir);
    return { events: await readRunTranscript(storage, itemId, runId) };
  });
}
