



import { ipcMain, type WebContents } from "electron";
import { fanOutToAllWindows } from "../window-fanout.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { createLogger } from "../../lib/logger.js";
import {
  DEFAULT_TOUR_STATE,
  readTourState,
  markScenarioComplete,
  dismissScenario,
  type TourState,
} from "../../main/tour-state-store.js";
import {
  isOnboardingProposalDisposition,
  pendingOnboardingProposals,
  readOnboardingProposalState,
  recordOnboardingProposalAnswer,
  type OnboardingProposalSource,
  type PendingOnboardingProposal,
} from "../../main/onboarding-proposal-store.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import { sendToWebContents } from "../safe-send.js";
import { DEFAULT_LOCALE } from "../../i18n/locale.js";
import type { IpcDeps } from "../types.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("tour-ipc");

export const TOUR_START_CHANNEL = CHANNELS.tour.start;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * What a proposal key may look like. It becomes an object key in
 * `proposals.json`, so it is bounded and restricted to the characters the two
 * halves it is built from can contain (`<pluginId>:<proposalId>`) — an
 * unbounded key would let a stray call grow the file without limit.
 */
const PROPOSAL_KEY_PATTERN = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
const PROPOSAL_KEY_MAX_LENGTH = 200;

/** Bounded to the manifest schema's own locale-tag ceiling. */
const LOCALE_TAG_MAX_LENGTH = 35;

function readLocale(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= LOCALE_TAG_MAX_LENGTH
    ? value
    : DEFAULT_LOCALE;
}

export function registerTourHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  /**
   * Proposal keys answered since this process started.
   *
   * A "later" answer is stored so the NEXT launch asks again; this set is what
   * stops the same launch from asking again the moment the card closes. Held in
   * the registration closure rather than at module scope so a test gets a fresh
   * launch by registering again.
   */
  const answeredThisLaunch = new Set<string>();

  /**
   * Compute what is still unanswered and stage the head of that queue as an
   * overlay card on the renderer that asked.
   *
   * ONE card at a time: the user answers a question before being shown the
   * next, and the next is chosen from state that already includes the answer
   * just given. The card goes out on the ordinary `OVERLAY_V1.show` path, so it
   * is queued, pinned to a tile, and navigated exactly like the plugin and
   * routine cards beside it — nothing about a proposal needs its own surface.
   *
   * This is NOT `triggerConversation`: no turn runs, and the prompt an accepted
   * composer action carries only reaches the composer.
   */
  const stagePendingProposals = async (
    sender: WebContents,
    locale: string,
  ): Promise<PendingOnboardingProposal[]> => {
    const sources: OnboardingProposalSource[] = deps.pluginRuntime
      .listPluginCards(deps.toolRegistry)
      .flatMap((card) =>
        card.loadStatus === "loaded" && card.active === true && card.onboarding !== undefined
          ? [{ pluginId: card.id, onboarding: card.onboarding }]
          : [],
      );
    const state = await readOnboardingProposalState();
    const pending = pendingOnboardingProposals(sources, state, answeredThisLaunch, locale);
    const head = pending[0];
    if (head) {
      sendToWebContents(
        sender,
        OVERLAY_V1.show,
        {
          id: `proposal:${head.key}`,
          source: {
            kind: "proposal" as const,
            pluginId: head.pluginId,
            proposalId: head.proposalId,
            action: head.action,
          },
          title: head.headline,
          summary: head.body,
          running: false,
          primaryActionLabel: head.actionLabel,
          createdAt: new Date().toISOString(),
        },
        log,
      );
    }
    return pending;
  };

  ipcMain.handle(
    CHANNELS.onboarding.listPending,
    async (
      e,
      payload: { locale?: unknown },
    ): Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.onboarding.listPending, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const pending = await stagePendingProposals(e.sender, readLocale(payload?.locale));
        return { ok: true, pending };
      } catch (err) {
        log.error({ err: errorMessage(err) }, "list-pending failed");
        return {
          ok: false,
          error: "read-failed",
          message: err instanceof Error ? err.message : "unknown read failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.onboarding.answer,
    async (
      e,
      payload: { key?: unknown; disposition?: unknown; locale?: unknown },
    ): Promise<
      | { ok: true; pending: PendingOnboardingProposal[] }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.onboarding.answer, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const key = payload?.key;
      if (
        !isNonEmptyString(key)
        || key.length > PROPOSAL_KEY_MAX_LENGTH
        || !PROPOSAL_KEY_PATTERN.test(key)
      ) {
        return {
          ok: false,
          error: "invalid-proposal-key",
          message: "key must be shaped <pluginId>:<proposalId>",
        };
      }
      const disposition = payload?.disposition;
      if (!isOnboardingProposalDisposition(disposition)) {
        return {
          ok: false,
          error: "invalid-disposition",
          message: "disposition must be accepted, never, or later",
        };
      }
      try {
        await recordOnboardingProposalAnswer(key, disposition);
        answeredThisLaunch.add(key);
        const pending = await stagePendingProposals(e.sender, readLocale(payload?.locale));
        return { ok: true, pending };
      } catch (err) {
        log.error({ err: errorMessage(err) }, "answer failed");
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.getState,
    async (
      e,
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.getState, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const state = await readTourState();
        return { ok: true, state };
      } catch (err) {
        log.warn(
          { err: errorMessage(err) },
          "read failed; falling back to default",
        );
        return { ok: true, state: DEFAULT_TOUR_STATE };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.markComplete,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.markComplete, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      try {
        const state = await markScenarioComplete(scenarioId);
        return { ok: true, state };
      } catch (err) {
        log.error(
          { err: errorMessage(err) },
          "mark-complete failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.dismiss,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; state: TourState }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.dismiss, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      try {
        const state = await dismissScenario(scenarioId);
        return { ok: true, state };
      } catch (err) {
        log.error(
          { err: errorMessage(err) },
          "dismiss failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.tour.start,
    async (
      e,
      payload: { scenarioId?: unknown },
    ): Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.tour.start, e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const scenarioId = payload?.scenarioId;
      if (!isNonEmptyString(scenarioId)) {
        return {
          ok: false,
          error: "invalid-scenario-id",
          message: "scenarioId must be a non-empty string",
        };
      }
      // Fan out through the curated app-renderer target set. Keeping this on
      // the shared helper preserves destroyed-window and send-race handling
      // if another trusted renderer surface is added later. `fanOutToAllWindows`
      // composes on safe-send's
      // per-window destroyed-check + send-race swallow; `log` receives the
      // per-window warn so one window's failure never blocks the others.
      const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
      fanOutToAllWindows(targets, TOUR_START_CHANNEL, { scenarioId }, { logger: log });
      return { ok: true, scenarioId };
    },
  );

}
