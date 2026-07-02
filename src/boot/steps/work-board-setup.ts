/**
 * Boot step — Work Board persistence + due-soon scanner (§4.2, extracted from
 * boot.ts C18).
 *
 * Runs the one-shot idempotent migration of a legacy plugin-owned board BEFORE
 * the store loads, reconciles interrupted runs, seeds first-run sample items,
 * and prepares the deferred due-soon scanner. The scanner itself is started
 * later by main.ts via `services.startWorkBoardDueSoon` (after IPC + plugins are
 * up); the interval handle lives on the context so `shutdown()` can clear it.
 */
import { WorkBoardStore } from "../../main/work-board-store.js";
import { migrateAgentHubBoardToWorkBoard } from "./work-board-migration.js";
import { seedSampleWorkBoard } from "../../work-board/sample-data.js";
import { scanAndEmitDueSoon } from "../../work-board/due-soon.js";
import { createDirStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { emitEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function setupWorkBoard(ctx: BootContext): Promise<void> {
  // Work board persistence (~/.lvis/work-board/board.json). One-shot,
  // idempotent migration of a legacy plugin-owned board runs BEFORE the
  // store loads so the store's first read picks up the migrated file. The
  // migration is a no-op once the host board exists (P2 wires the
  // runner/engine; the store is pure persistence here).
  const workBoardMigrated = await migrateAgentHubBoardToWorkBoard();
  const workBoardStore = new WorkBoardStore();
  await workBoardStore.load().catch((err) => {
    log.warn("boot: work-board load failed (non-fatal): %s", (err as Error).message);
  });
  // Reset runs interrupted by a prior process exit (persisted active runStatus
  // with no in-flight run) so those items are re-runnable + don't show a stuck
  // "running" badge.
  await workBoardStore
    .reconcileInterruptedRuns()
    .catch((err) =>
      log.warn("boot: work-board run reconcile failed (non-fatal): %s", (err as Error).message),
    );

  // Due-soon nudge: a 60-min tick scans the board and emits
  // `work_board.work_item.due_soon` on the plugin bus for any subscribed
  // due-soon consumer. Deferred-started (after IPC + plugins are up)
  // via services.startWorkBoardDueSoon; the timer is cleared on shutdown.
  const workBoardStorage = createDirStorage(openFeatureNamespace("work-board").dir);

  // First-run onboarding: seed clearly-labelled sample items so a brand-new
  // board demonstrates the agentic flow (create → approve → execute → output)
  // for the user guide. One-time (keyed by a marker file) and skipped when the
  // board was migrated or already has items — a real board is never seeded.
  await seedSampleWorkBoard({
    store: workBoardStore,
    marker: workBoardStorage,
    alreadyMigrated: workBoardMigrated,
    now: Date.now,
  }).catch((err) =>
    log.warn("boot: work-board sample seed failed (non-fatal): %s", (err as Error).message),
  );

  const DUE_SOON_TICK_MS = 60 * 60_000;
  const runDueSoonScan = (): void => {
    void scanAndEmitDueSoon(workBoardStore, workBoardStorage, emitEvent, Date.now())
      .then((fired) => {
        if (fired.length) log.info("work-board: emitted %d due_soon nudge(s)", fired.length);
      })
      .catch((err) =>
        log.warn("work-board: due_soon scan failed (non-fatal): %s", (err as Error).message),
      );
  };

  ctx.workBoardStore = workBoardStore;
  ctx.workBoardStorage = workBoardStorage;
  // Deferred due-soon scanner handle. main.ts calls this AFTER
  // registerIpcHandlers() so the initial scan + 60-min tick emit onto a fully
  // wired plugin bus. The interval is cleared in `shutdown()`.
  ctx.startWorkBoardDueSoon = () => {
    runDueSoonScan();
    ctx.dueSoonTimer = setInterval(runDueSoonScan, DUE_SOON_TICK_MS);
  };
}
