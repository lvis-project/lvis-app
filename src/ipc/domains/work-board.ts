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
 * The `run` and `generate-report` channels are intentionally NOT registered
 * here — they require the work-board runner/engine, wired in a later phase.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import type {
  WorkItemCreateInput,
  WorkItemUpdateInput,
  WorkItemListFilter,
  WorkItemStatusStored,
  WorkItemChangedEventPayload,
} from "../../main/work-board-store.js";

/** Shared "store not constructed at boot" envelope for the mutating channels. */
const NO_STORE = { ok: false, error: "no-store" as const };

export function registerWorkBoardHandlers(deps: IpcDeps): void {
  const { workBoardStore, auditLogger, getMainWindow, getAppWindows } = deps;

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
}
