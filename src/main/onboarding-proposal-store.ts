/**
 * Onboarding proposal dispositions — `~/.lvis/onboarding/proposals.json`.
 *
 * A plugin proposes onboarding highlights and new-feature promotions through
 * its manifest. The host asks each one ONCE and remembers the answer, so this
 * store holds the three answers a user can give and the selection that turns
 * "what a plugin declared" into "what the user has not answered yet".
 *
 * The three answers are not a snooze ladder. `accepted` and `never` are
 * terminal — the proposal is finished, whichever way the user went. `later` is
 * the only one that comes back, and it comes back on the NEXT launch rather
 * than after a timer: the user said not now, and "now" ends when the app does.
 *
 * Selection lives here, next to the answers it filters by, and NOT in the
 * renderer. A card is pushed one at a time; if the renderer picked, the pick
 * would be made once per window and two windows would show two different
 * proposals for the same unanswered question.
 */
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import type {
  PluginOnboardingAction,
  PluginOnboardingSpec,
} from "../plugins/public-contract.js";

/** `~/.lvis/onboarding/` namespace — shares the directory with `tour-state.json`. */
const ns = openFeatureNamespace("onboarding");
const PROPOSALS_FILE = "proposals.json";

/**
 * The proposalId a plugin's `onboarding.firstTask` is keyed under.
 *
 * `firstTask` carries no id of its own — there is at most one per plugin — but
 * an answer has to be stored under something, and the same `<pluginId>:<id>`
 * key shape has to address both kinds. Fixed rather than derived so a stored
 * answer keeps meaning the same proposal.
 */
export const FIRST_TASK_PROPOSAL_ID = "first-task";

export type OnboardingProposalDisposition = "accepted" | "never" | "later";

interface OnboardingProposalAnswer {
  disposition: OnboardingProposalDisposition;
  /** ISO timestamp of the answer. */
  answeredAt: string;
}

export interface OnboardingProposalState {
  /** Keyed `<pluginId>:<proposalId>`. */
  answers: Record<string, OnboardingProposalAnswer>;
}

const EMPTY_STATE: OnboardingProposalState = { answers: {} };

/** The storage key for one proposal. Both kinds share the shape. */
export function onboardingProposalKey(pluginId: string, proposalId: string): string {
  return `${pluginId}:${proposalId}`;
}

const DISPOSITIONS: ReadonlySet<string> = new Set([
  "accepted",
  "never",
  "later",
] satisfies OnboardingProposalDisposition[]);

export function isOnboardingProposalDisposition(
  value: unknown,
): value is OnboardingProposalDisposition {
  return typeof value === "string" && DISPOSITIONS.has(value);
}

/**
 * Drop anything that is not a well-formed answer.
 *
 * A hand-edited or drifted file must not be able to introduce a disposition
 * the selection below does not understand: an unrecognised value would fall
 * through every terminal check and leave the proposal permanently pending or
 * permanently silent depending on which check ran first. Unreadable entries
 * are dropped, which asks the question again — the safe direction, since the
 * alternative is silencing a card the user never answered.
 */
function normaliseState(raw: unknown): OnboardingProposalState {
  if (!raw || typeof raw !== "object") return { answers: {} };
  const candidate = (raw as { answers?: unknown }).answers;
  if (!candidate || typeof candidate !== "object") return { answers: {} };
  const answers: Record<string, OnboardingProposalAnswer> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { disposition, answeredAt } = value as {
      disposition?: unknown;
      answeredAt?: unknown;
    };
    if (!isOnboardingProposalDisposition(disposition)) continue;
    if (typeof answeredAt !== "string") continue;
    answers[key] = { disposition, answeredAt };
  }
  return { answers };
}

/**
 * Read the stored answers. Like the neighbouring tour state, a missing or
 * corrupt file resolves to the empty state rather than throwing: this is a
 * user-preference store, and losing it re-asks questions instead of blocking
 * the host.
 */
export async function readOnboardingProposalState(): Promise<OnboardingProposalState> {
  const parsed = await ns.readJson<unknown>(PROPOSALS_FILE, EMPTY_STATE);
  return normaliseState(parsed);
}

/**
 * Record one answer and return the state that was written. Re-answering a key
 * replaces the previous answer — the user's latest word is the one that counts.
 */
export async function recordOnboardingProposalAnswer(
  key: string,
  disposition: OnboardingProposalDisposition,
): Promise<OnboardingProposalState> {
  if (!key) throw new Error("invalid-proposal-key");
  const current = await readOnboardingProposalState();
  const next: OnboardingProposalState = {
    answers: {
      ...current.answers,
      [key]: { disposition, answeredAt: new Date().toISOString() },
    },
  };
  await ns.writeJson(PROPOSALS_FILE, next);
  return next;
}

/** One plugin's declared onboarding, as the selection below needs it. */
export interface OnboardingProposalSource {
  pluginId: string;
  onboarding: PluginOnboardingSpec;
}

/** One proposal the user has not answered, with its copy already resolved. */
export interface PendingOnboardingProposal {
  /** `<pluginId>:<proposalId>` — what {@link recordOnboardingProposalAnswer} takes. */
  key: string;
  pluginId: string;
  proposalId: string;
  headline: string;
  body: string;
  actionLabel: string;
  action: PluginOnboardingAction;
}

function normaliseLocaleTag(locale: string): string {
  return locale.trim().toLowerCase().replaceAll("_", "-");
}

/**
 * Resolve per-locale copy: exact tag, then the bare language, then English.
 * English is required by the manifest schema, so the last step always lands.
 */
function resolveCopy<T>(locales: Record<string, T>, locale: string): T | undefined {
  const normalized = normaliseLocaleTag(locale);
  const primary = normalized.split("-")[0];
  return locales[normalized] ?? locales[primary] ?? locales.en;
}

/**
 * Order within one launch: every `firstTask` before every highlight, then by
 * declared priority, then by plugin and proposal id.
 *
 * The kind comes first because `firstTask` is what a plugin nominates as the
 * thing to do after the tour, and a highlight from another plugin arriving
 * ahead of it would answer a question the user was not yet asked. Within a
 * kind the declared priority decides, and the ids break the remaining ties so
 * two launches with the same plugins propose in the same order.
 */
const FIRST_TASK_RANK = 0;
const HIGHLIGHT_RANK = 1;
/** Sorts an omitted highlight priority last, above the schema's own ceiling. */
const UNSPECIFIED_PRIORITY = 1001;

interface RankedProposal extends PendingOnboardingProposal {
  rank: number;
  priority: number;
}

/**
 * The proposals nobody has answered yet, in the order they should be asked.
 *
 * `answeredThisLaunch` holds the keys already answered since the process
 * started. It is what makes `later` mean "not this run": the stored answer
 * says the user deferred, and this set stops the deferral from being re-asked
 * moments after it was given.
 */
export function pendingOnboardingProposals(
  sources: readonly OnboardingProposalSource[],
  state: OnboardingProposalState,
  answeredThisLaunch: ReadonlySet<string>,
  locale: string,
): PendingOnboardingProposal[] {
  const ranked: RankedProposal[] = [];
  for (const { pluginId, onboarding } of sources) {
    const consider = (candidate: RankedProposal): void => {
      const stored = state.answers[candidate.key]?.disposition;
      if (stored === "accepted" || stored === "never") return;
      if (answeredThisLaunch.has(candidate.key)) return;
      ranked.push(candidate);
    };

    const firstTask = onboarding.firstTask;
    if (firstTask) {
      const copy = resolveCopy(firstTask.locales, locale);
      if (copy) {
        consider({
          key: onboardingProposalKey(pluginId, FIRST_TASK_PROPOSAL_ID),
          pluginId,
          proposalId: FIRST_TASK_PROPOSAL_ID,
          headline: copy.headline,
          body: copy.body,
          actionLabel: copy.actionLabel,
          action: { kind: "composer", prompt: copy.composerPrompt },
          rank: FIRST_TASK_RANK,
          priority: firstTask.priority,
        });
      }
    }

    for (const highlight of onboarding.highlights ?? []) {
      const copy = resolveCopy(highlight.copy, locale);
      if (!copy) continue;
      consider({
        key: onboardingProposalKey(pluginId, highlight.id),
        pluginId,
        proposalId: highlight.id,
        headline: copy.headline,
        body: copy.body,
        actionLabel: copy.actionLabel,
        action: highlight.action,
        rank: HIGHLIGHT_RANK,
        priority: highlight.priority ?? UNSPECIFIED_PRIORITY,
      });
    }
  }

  ranked.sort(
    (left, right) =>
      left.rank - right.rank
      || left.priority - right.priority
      || (left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0)
      || (left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0),
  );

  return ranked.map(({ rank: _rank, priority: _priority, ...proposal }) => proposal);
}
