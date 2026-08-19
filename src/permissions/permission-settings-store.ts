/**
 * Permission policy — `~/.lvis/settings.json` permissions block.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 1.
 *
 * This is a focused store for the Permission policy permission settings only — the
 * existing `SettingsService` (lvis-settings.json under Electron's
 * userData) is unchanged. Permission policy settings live in `~/.lvis/settings.json`
 * because the spec carves out a permissions namespace there:
 *
 * ```jsonc
 * {
 *   "permissions": {
 *     "additionalDirectories": ["~/workspace/lvis"]
 *   }
 * }
 * ```
 *
 * Atomic cutover: an absent `additionalDirectories` key means "use
 * defaults only" (NOT silent allow). Callers compose with
 * `buildAllowedScope(...)` which adds the host defaults.
 *
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  PARENT_ADJUDICATION_CONTEXT_TURNS_MAX,
  PARENT_ADJUDICATION_CONTEXT_TURNS_MIN,
  PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MAX,
  PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MIN,
  PARENT_ADJUDICATION_TIMEOUT_MS_MAX,
  PARENT_ADJUDICATION_TIMEOUT_MS_MIN,
} from "../shared/parent-adjudication-bounds.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";

const log = createLogger("permission-settings");

/**
 * Reviewer mode semantics (post issue #664 P0 normalization):
 *
 * - "disabled" — reviewer lane bypassed. All invocations classify as LOW. The
 *   per-tool category × source × trust matrix in {@link PermissionManager} still
 *   applies (deny rules, allowed-dir checks, overlay-trigger guards, explicit
 *   user approval flows). This mode is for users who DO NOT want LLM/rule-based
 *   risk classification gating their plugin tool calls. Pre-#664 this mode was
 *   wired as "fail-closed defer all", which contradicted both the name and
 *   user expectation — that semantic moved to "strict".
 *
 * - "rule" — deterministic 36-rule heuristic. No LLM call.
 *
 * - "llm" — LLM-backed classifier with rule composition (max(rule, llm)).
 *
 * - "strict" — fail-closed: every reviewer dispatch returns HIGH and is sent
 *   to the deferred queue. Equivalent to the pre-#664 "disabled" semantic but
 *   under an honest name. Use for security-hardened deployments where every
 *   headless mutation must be manually approved.
 */
export type ReviewerMode = "disabled" | "rule" | "llm" | "strict";
/** Canonical list of all supported reviewer providers — single SOT. */
export const REVIEWER_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "foundry",
  "gcp-playground",
] as const;
export type ReviewerProvider = (typeof REVIEWER_PROVIDERS)[number];
export type ReviewerFallbackOnError = "deny" | "rule";

/**
 * Interactive auto-approve policy — issue #690.
 *
 *   - "off"  : reviewer never auto-approves in interactive (foreground)
 *              flow. Every ask hits the approval dock.
 *   - "low"  : reviewer's LOW verdict in interactive flow silently
 *              allows the call without showing the prompt. MEDIUM/HIGH ask.
 *   - "medium": reviewer LOW and MEDIUM verdicts in interactive flow silently
 *              allow the call without showing the prompt. HIGH still asks.
 *
 * This inclusive threshold applies only to the foreground reviewer route.
 * Headless review remains fail-closed for MEDIUM and HIGH.
 */
export type ReviewerInteractiveAutoApprove = "off" | "low" | "medium";

export interface ReviewerInteractiveBlock {
  autoApprove: ReviewerInteractiveAutoApprove;
}

/**
 * Highest reviewer verdict a parent agent is allowed to adjudicate for its own
 * child (tier 2 of the sub-agent approval chain).
 *
 * `"high"` is deliberately absent from the type, not merely absent from the
 * default: a HIGH verdict is the class of call the user asked to see, and a
 * ceiling the settings file could raise to `"high"` would let a hand-edited
 * file hand the whole class to an agent. The host checks this ceiling before
 * the parent is asked at all, so no parent answer can exceed it.
 */
export type ParentAdjudicationMaxVerdict = "low" | "medium";

/**
 * Where a tier-3 escalation goes when nobody is watching the child run.
 *
 *   - `"deferred"` — the ask is denied fail-closed and recorded in the deferred
 *     queue with an OS notification, so a background child neither blocks on a
 *     dock nobody is looking at nor waits out the five-minute approval timeout.
 *   - `"modal"` — the pre-existing behaviour: the dock is painted immediately
 *     whatever the run is.
 *
 * `"deferred"` only diverts an ask the host can establish nobody would see: a
 * background run while the app window is hidden or minimised, or any run while
 * the away answerer is armed. With the window in front of the user, every
 * escalation still paints the dock under both values — the queue cannot
 * re-drive a call whose turn is over, so it is the weaker answer whenever a
 * human is actually there to give the stronger one.
 */
export type ParentAdjudicationBackgroundEscalation = "deferred" | "modal";

/**
 * Which model answers the tier-2 side turn.
 *
 *   - `"reviewer"` — the permission reviewer's own adapter. It is already
 *     wired, already trusted with risk classification, and costs nothing extra
 *     to reach.
 *   - `"parent-session"` — the chat provider/model the parent's own loop runs
 *     on. It reasons about the parent's task with the parent's own model, and
 *     it is available even in reviewer modes that wire no LLM at all.
 *
 * COST: `"parent-session"` bills one extra call on the (usually larger) chat
 * model for every adjudicated sub-agent tool call, bounded by `maxPerChildRun`
 * per child run. `"reviewer"` is the cheaper default for that reason.
 */
export type ParentAdjudicationModelSource = "reviewer" | "parent-session";

// Bounds for the numeric fields of ReviewerParentAdjudicationBlock live in
// shared/parent-adjudication-bounds.ts — the settings form mirrors the same
// ceilings it types values against, so they cannot be declared per layer.

/**
 * Tier-2 (parent-adjudication) policy for sub-agent tool approvals.
 *
 * Every field is a ceiling on what the lane may do, never a widening: the lane
 * is skipped entirely unless the feature flag is on AND the request is
 * eligible, and each of these only narrows it further.
 *
 * Reachable through {@link ReviewerSettingsBlock.parentAdjudication}, and read
 * by the approval gate's tier-2 stage through the policy accessor it is wired
 * with — the gate reads the live block per request rather than a value
 * captured at boot, so a narrowed ceiling takes effect on the next ask.
 */
export interface ReviewerParentAdjudicationBlock {
  /** Verdict ceiling enforced by the host before the parent is asked. */
  maxVerdict: ParentAdjudicationMaxVerdict;
  /**
   * How long one adjudication may take, measured from the moment it enters the
   * queue rather than from the moment it starts, so a queue behind a slow
   * adjudication cannot push a later request past this bound before it
   * escalates to the user.
   */
  timeoutMs: number;
  /**
   * Adjudications a single child run may consume. Past it the lane escalates
   * to the user, so a child cannot spend the parent's judgement as a resource
   * to exhaust.
   */
  maxPerChildRun: number;
  /**
   * How many of the parent conversation's most recent turns are quoted into
   * the adjudication evidence. `0` — the default — includes none.
   *
   * Opt-in rather than on, because it is the one field of this block that
   * widens what leaves the machine: the turns are the user's own words, and
   * they travel to whichever provider answers the side turn — which under the
   * default `model: "reviewer"` is the REVIEWER's configured vendor and
   * endpoint (a marketplace preset's `baseUrl`, if one is selected), not
   * necessarily the chat provider the conversation itself runs on. What the host
   * composes from them is bounded, DLP-masked and quoted as data, and no
   * sub-agent report is ever among them (a child could otherwise argue for its
   * own approval through its parent's transcript).
   */
  includeParentContextTurns: number;
  /** Where a tier-3 escalation goes for a background child run. */
  backgroundEscalation: ParentAdjudicationBackgroundEscalation;
  /** Which model answers the side turn. See the type for the cost note. */
  model: ParentAdjudicationModelSource;
}

/**
 * Permission policy P3 — `permissions.reviewer` block. Provider/model remain
 * persisted for legacy command compatibility; runtime LLM reviewer wiring now
 * follows the active chat LLM provider/model when available.
 * Defaults: provider="openai", model="gpt-4o-mini",
 * fallbackOnError="deny", interactive.autoApprove="medium".
 */
export interface ReviewerSettingsBlock {
  mode: ReviewerMode;
  provider: ReviewerProvider;
  model: string;
  fallbackOnError: ReviewerFallbackOnError;
  interactive: ReviewerInteractiveBlock;
  /** Tier-2 policy for sub-agent asks a parent agent may decide. */
  parentAdjudication: ReviewerParentAdjudicationBlock;
  /**
   * Issue #664 migration marker — ISO-8601 timestamp recorded the first
   * time a pre-#664 `mode:"disabled"` setting was rewritten to
   * `mode:"strict"`. Pre-#664 builds wired `disabled` as "defer-all-HIGH"
   * (fail-closed), so an existing user file with `mode:"disabled"` and no
   * marker represents a fail-closed posture the user actively chose. The
   * #664 normalization flipped `disabled` to pass-through-LOW; without
   * this migration that flip would be a silent post-deploy security
   * downgrade. The presence of `disabledMigratedAt` makes the migration
   * idempotent — subsequent loads do not re-write.
   */
  disabledMigratedAt?: string;
}

export interface PermissionSettingsBlock {
  additionalDirectories: string[];
  pendingWorkspaceRootRemovals: PendingWorkspaceRootRemoval[];
  reviewer: ReviewerSettingsBlock;
}

/** Durable forward-only cleanup journal for a removed workspace root. */
export interface PendingWorkspaceRootRemoval {
  operationId: string;
  storedPath: string;
  runtimePath: string;
  requestedAt: string;
  source: string;
}

/**
 * What a read could NOT interpret in the on-disk file.
 *
 * The settings file is an external boundary: it is hand-editable, it is
 * restored from backups, and a half-written predecessor of the atomic writer
 * could survive a crash. None of that may be answered by pretending the user
 * simply has no projects — "we could not read your settings" and "you have no
 * extra directories" are different facts and the UI owes the user the first
 * one. So a read reports the condition here instead of erasing it, and the
 * file itself is left byte-for-byte as it was found.
 */
type PermissionSettingsFault =
  | {
      /** The whole file failed to parse. No grant in it can be honoured. */
      kind: "file-unreadable";
      filePath: string;
      detail: string;
    }
  | {
      /** Individual cleanup-journal entries failed validation. */
      kind: "pending-removals-malformed";
      filePath: string;
      /** How many entries were kept on disk but not interpreted. */
      entries: number;
    };

export interface PermissionSettingsFile {
  permissions: PermissionSettingsBlock;
  /**
   * `null` when the file was interpreted whole. Callers that GATE on the
   * settings (the executor allow-list, the reviewer) deliberately ignore it:
   * with an uninterpretable SOT the only honest gate answer is the deny-shaped
   * default this read returns with it. Callers that DISPLAY the settings must
   * not — a fault means the list they are about to draw is not the user's.
   */
  fault: PermissionSettingsFault | null;
}

/**
 * A write path found the settings file unparseable.
 *
 * Merging into `{}` instead would let the next write replace every unrelated
 * top-level key the user has in that file, so a write refuses. The file is
 * left untouched for a hand-repair or a restore.
 */
export class PermissionSettingsUnreadableError extends Error {
  readonly code = "settings-unreadable";
  constructor(
    readonly filePath: string,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`permission settings at ${filePath} are unreadable: ${detail}`, options);
    this.name = "PermissionSettingsUnreadableError";
  }
}

const DEFAULT_REVIEWER: ReviewerSettingsBlock = {
  // Default to "llm": LLM-backed risk review (rule composition, max(rule,llm))
  // is the strongest available classification for a fresh install. When the
  // active chat LLM provider/key is not yet configured (fresh install before
  // login), boot wiring cannot instantiate the reviewer adapter — instead of
  // crashing or silently passing everything, `wireReviewerAgent` degrades to
  // the deterministic rule classifier (see reviewer-wiring.ts). The degrade is
  // self-healing: as soon as a provider/key is configured, the auth + settings
  // rewire path re-fires wiring and the reviewer returns to "llm".
  //
  // `interactive.autoApprove: "medium"` lets LOW and MEDIUM verdicts in the
  // foreground chat flow silently allow without a prompt. HIGH still returns to
  // the main LLM as a blocked tool result. This threshold applies in auto mode;
  // the headless lane remains unaffected.
  //
  // Why not "rule" as the default: rule is the *degraded* posture, not the
  // intended one. Encoding "llm" as the default keeps the intent visible and
  // makes the degrade observable (banner + boot warn) rather than baking the
  // weaker classifier in as the silent baseline. Sandbox-internal plugin
  // writes still collapse to LOW via the #664-P1 auto-LOW rule — now keyed on
  // the HOST-computed `ownerPluginSandboxRoot` + path-containment (#885 v6 Q4;
  // the manifest `writesToOwnSandbox` self-claim was removed) — in either mode,
  // so the #664 fresh-install flood does not reappear under the degraded rule
  // classifier.
  mode: "llm",
  provider: "openai",
  model: "gpt-4o-mini",
  fallbackOnError: "deny",
  interactive: { autoApprove: "medium" },
  // Tier 2 mirrors the interactive threshold: the parent may decide exactly
  // the band the reviewer would have auto-approved one notch lower, and HIGH
  // stays with the user under every setting. 30s is the wait a blocked child
  // can absorb before the user is better served by the dock; 200 keeps a long
  // multi-file child run from escalating on volume alone.
  // Parent context is off: the lane works without it, and the version of it
  // that ships on by default would be the one that starts sending the user's
  // conversation to a provider nobody asked to send it to.
  //
  // A background child escalates into the deferred queue rather than onto a
  // dock: its turn is not one anybody is watching, and a modal it raises is a
  // modal that waits out the approval timeout into the same denial the queue
  // records immediately — with none of the queue's later review.
  parentAdjudication: {
    maxVerdict: "medium",
    timeoutMs: 30_000,
    maxPerChildRun: 200,
    includeParentContextTurns: 0,
    backgroundEscalation: "deferred",
    model: "reviewer",
  },
};

const REVIEWER_INTERACTIVE_AUTO_APPROVES: ReadonlySet<ReviewerInteractiveAutoApprove> =
  new Set(["off", "low", "medium"]);

const PARENT_ADJUDICATION_MAX_VERDICTS: ReadonlySet<ParentAdjudicationMaxVerdict> =
  new Set(["low", "medium"]);

const PARENT_ADJUDICATION_BACKGROUND_ESCALATIONS: ReadonlySet<ParentAdjudicationBackgroundEscalation> =
  new Set(["deferred", "modal"]);

const PARENT_ADJUDICATION_MODEL_SOURCES: ReadonlySet<ParentAdjudicationModelSource> =
  new Set(["reviewer", "parent-session"]);

const DEFAULT_FILE: PermissionSettingsFile = {
  permissions: {
    additionalDirectories: [],
    pendingWorkspaceRootRemovals: [],
    reviewer: { ...DEFAULT_REVIEWER },
  },
  fault: null,
};

const REVIEWER_MODES: ReadonlySet<ReviewerMode> = new Set([
  "disabled",
  "rule",
  "llm",
  "strict",
]);
/** Exported so IPC handlers can validate provider names against a single SOT. */
export const REVIEWER_PROVIDERS_SET: ReadonlySet<ReviewerProvider> = new Set(REVIEWER_PROVIDERS);
const REVIEWER_FALLBACKS: ReadonlySet<ReviewerFallbackOnError> = new Set(["deny", "rule"]);

function defaultPath(): string {
  return pathResolve(lvisHome(), "settings.json");
}

/**
 * Read `~/.lvis/settings.json`. Missing file → DEFAULT_FILE.
 *
 * A file that exists but cannot be interpreted returns the deny-shaped
 * DEFAULT_FILE *carrying* {@link PermissionSettingsFile.fault}, logs at error,
 * and rewrites nothing. Deny is the only honest gate answer when the grant SOT
 * is unreadable; the fault is what keeps that answer from reading as "the user
 * has no projects" on the surfaces that show them.
 *
 * Issue #664 migration: when a pre-#664 file is detected (mode:"disabled"
 * without `disabledMigratedAt` marker), the reviewer mode is rewritten to
 * "strict" *and persisted* before returning. The on-disk file converges to
 * the post-#664 canonical shape on the first read after upgrade, so
 * subsequent loads do not re-rewrite. Persistence failure is logged but
 * the in-memory result is still the migrated (strict) shape — the user
 * never silently lands on the new pass-through-LOW semantic.
 *
 * `pathOverride` is for tests.
 */
export function readPermissionSettings(pathOverride?: string): PermissionSettingsFile {
  const filePath = pathOverride ?? defaultPath();
  if (!existsSync(filePath)) return structuredClone(DEFAULT_FILE);
  let parsed: Record<string, unknown>;
  try {
    parsed = readSettingsDocument(filePath);
  } catch (err) {
    const detail = (err as Error).message;
    log.error(
      "permission settings at %s are unreadable: %s — file preserved untouched, no directories granted",
      filePath,
      detail,
    );
    return {
      ...structuredClone(DEFAULT_FILE),
      fault: { kind: "file-unreadable", filePath, detail },
    };
  }
  {
    const migrated = migrateLegacyDisabledMode(parsed);
    const normalized = normalizePermissionSettings(parsed, filePath);
    if (migrated) {
      // Persist the migration synchronously so the file converges to the
      // post-#664 shape. We do a best-effort write — if the file is locked
      // or the disk is read-only, we still return the migrated in-memory
      // result so the user's runtime behaviour is fail-closed (strict).
      try {
        writeUtf8FileAtomicSync(filePath, JSON.stringify(parsed, null, 2), 0o600);
      } catch (persistErr) {
        log.warn(
          "issue-664 migration: failed to persist migrated settings to %s — runtime still strict (%s)",
          filePath,
          (persistErr as Error).message,
        );
      }
    }
    return normalized;
  }
}

/**
 * Read the settings document off disk, throwing when it cannot be interpreted.
 *
 * An empty file is not damage: `withFileLock` creates the target as a
 * zero-byte placeholder so `proper-lockfile` can stat it, so every first write
 * this store ever performs starts from one. A non-object root (`null`, an
 * array, a bare number) IS damage — every reader below indexes the result as a
 * record — so it is rejected here rather than in each of them.
 */
function readSettingsDocument(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  if (raw.trim().length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings root is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read the settings object a write path is about to merge into.
 *
 * Refusing an unparseable file is the whole point: the previous `catch {}`
 * here merged into an empty object, so the next successful write replaced the
 * user's entire settings document — every unrelated top-level key included —
 * with whatever that one mutation happened to hold.
 */
function readSettingsObjectForUpdate(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return readSettingsDocument(filePath);
  } catch (err) {
    throw new PermissionSettingsUnreadableError(filePath, (err as Error).message, { cause: err });
  }
}

/**
 * Issue #664 boot-time migration shim.
 *
 * Detects a pre-#664 settings file by the (mode==="disabled" AND no
 * disabledMigratedAt marker) signature and rewrites the in-memory object
 * to `mode:"strict"` + marker. Returns `true` when the mutation happened
 * so the caller can persist.
 *
 * Pre-#664 `disabled` was wired as "defer-all-HIGH" (fail-closed). Post-#664
 * `disabled` is pass-through-LOW. Without this migration a user who
 * explicitly opted into the fail-closed posture would silently land on
 * pass-through after the upgrade — a security regression.
 *
 * Idempotency: the marker is written once and only once. A user who later
 * deliberately picks `mode:"disabled"` after the migration (via slash
 * command or hand-edit) gets the new pass-through semantic without
 * re-migration because the marker is already present.
 *
 * Out-of-band: this is the only auto-rewrite the loader performs. All
 * other validation falls back to defaults without mutation.
 */
export function migrateLegacyDisabledMode(parsed: Record<string, unknown>): boolean {
  const perm = parsed.permissions;
  if (!perm || typeof perm !== "object") return false;
  const reviewer = (perm as Record<string, unknown>).reviewer;
  if (!reviewer || typeof reviewer !== "object") return false;
  const r = reviewer as Record<string, unknown>;
  if (r.mode !== "disabled") return false;
  if (typeof r.disabledMigratedAt === "string" && r.disabledMigratedAt.length > 0) {
    return false;
  }
  const migratedAt = new Date().toISOString();
  r.mode = "strict";
  r.disabledMigratedAt = migratedAt;
  log.warn(
    "issue-664 migration: legacy reviewer mode 'disabled' (defer-all-HIGH) → 'strict' (defer-all-HIGH, honest name); marker=%s",
    migratedAt,
  );
  return true;
}

/**
 * Normalize an arbitrary parsed JSON value into a valid
 * PermissionSettingsFile. Only `permissions.additionalDirectories` is
 * accepted as the persisted directory SOT.
 */
export function normalizePermissionSettings(
  parsed: Record<string, unknown>,
  filePath: string,
): PermissionSettingsFile {
  const perm = (parsed.permissions ?? {}) as Record<string, unknown>;
  const journal = partitionPendingWorkspaceRootRemovals(perm.pendingWorkspaceRootRemovals);
  const pendingWorkspaceRootRemovals = journal.intents;
  if (journal.malformed.length > 0) {
    log.error(
      "permissions.pendingWorkspaceRootRemovals in %s holds %d entry/entries that could not be interpreted — kept on disk, skipped at runtime",
      filePath,
      journal.malformed.length,
    );
  }
  // A damaged entry can still NAME a root, and every path it names is honoured
  // as a pending removal even though the entry as a whole cannot be acted on.
  //
  // What this masking is FOR. `beginWorkspaceRootRemovalPersist` drops the path
  // from `additionalDirectories` in the SAME atomic write that appends the
  // intent, so a root with a removal in flight is already absent from the list.
  // The masking therefore only decides the case where the path is in the list
  // anyway — a hand edit or an interrupted legacy write, not an in-app add,
  // which `addAllowedDirectoryPersist` refuses outright while an intent for that
  // root is pending — and there the journal wins over the list.
  //
  // What it is NOT. An entry that names nothing (`null`, `7`, an object with no
  // readable path) masks nothing, so a path a hand edit put back stays active.
  // That residual is deliberate, and it is not a hole in a defence because
  // there is no defence here to hole: the same hand edit that put the path back
  // could have written `pendingWorkspaceRootRemovals: []` instead — a valid
  // journal that raises no fault and leaves that path exactly as active.
  //
  // Mind the scope of that argument, because its general form is FALSE: an
  // empty journal reactivates nothing by itself. After a normal
  // `beginWorkspaceRootRemovalPersist` the path is already gone from
  // `additionalDirectories`, so clearing the journal leaves the read answering
  // with the root still absent and no fault. `[]` is an equally easy substitute
  // for the unattributable entry only in the case this paragraph is about,
  // where the path is back in the list as well.
  //
  // This journal is crash recovery, not tamper-evidence. Emptying the list on an
  // unattributable entry would trade every readable grant for one unreadable
  // non-grant and buy nothing, so the entry is reported as a fault the UI must
  // show instead.
  const pendingPaths = [
    ...pendingWorkspaceRootRemovals.map((intent) => intent.runtimePath),
    ...journal.malformed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      return [value.runtimePath, value.storedPath].filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      );
    }),
  ];
  const pendingKeys = new Set(
    pendingPaths.flatMap((path) => {
      const key = allowedDirectoryKey(path);
      return key === null ? [] : [key];
    }),
  );
  const additional = perm.additionalDirectories;
  let dirs: string[] = [];
  if (Array.isArray(additional)) {
    dirs = additional.filter((s): s is string => {
      if (typeof s !== "string" || s.length === 0) return false;
      const key = allowedDirectoryKey(s);
      // Pending wins over a conflicting hand edit or interrupted legacy write.
      return key === null || !pendingKeys.has(key);
    });
  }
  return {
    permissions: {
      additionalDirectories: dirs,
      pendingWorkspaceRootRemovals,
      reviewer: normalizeReviewerBlock(perm.reviewer),
    },
    fault:
      journal.malformed.length > 0
        ? {
            kind: "pending-removals-malformed",
            filePath,
            entries: journal.malformed.length,
          }
        : null,
  };
}

/**
 * The cleanup journal split into what can be acted on and what cannot.
 *
 * It used to throw on the first bad entry, and every caller — the reader and
 * all three writers — called it outside their own error handling, so one
 * malformed entry took out every directory ADD as well: the settings file had
 * no route back to a valid journal from inside the app, and the reader
 * answered the same corruption with an empty project list. Splitting is what
 * removes the deadlock without deciding, on the user's behalf, that their
 * queued removals were worthless: the malformed entries stay verbatim in
 * {@link PendingWorkspaceRootRemovalJournal.malformed} so a write puts them
 * back exactly as it found them, and the read reports them as a fault.
 */
interface PendingWorkspaceRootRemovalJournal {
  intents: PendingWorkspaceRootRemoval[];
  /** Entries kept verbatim, never interpreted and never dropped. */
  malformed: unknown[];
}

function partitionPendingWorkspaceRootRemovals(
  parsed: unknown,
): PendingWorkspaceRootRemovalJournal {
  if (parsed === undefined) return { intents: [], malformed: [] };
  // A non-array value carries no entry to keep apart, so the value itself is
  // the thing preserved — a later write returns it to the journal as one
  // element of the array, after whatever intents that write decided on, rather
  // than deleting a key it cannot read. It is the sole element only when the
  // write leaves no intents behind.
  if (!Array.isArray(parsed)) return { intents: [], malformed: [parsed] };
  const seenOperations = new Set<string>();
  const intents: PendingWorkspaceRootRemoval[] = [];
  const malformed: unknown[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") {
      malformed.push(candidate);
      continue;
    }
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId)
      || typeof value.storedPath !== "string"
      || value.storedPath.length === 0
      || typeof value.runtimePath !== "string"
      || value.runtimePath.length === 0
      || typeof value.requestedAt !== "string"
      || value.requestedAt.length === 0
      || typeof value.source !== "string"
      || value.source.length === 0
      || seenOperations.has(value.operationId)
    ) {
      malformed.push(candidate);
      continue;
    }
    seenOperations.add(value.operationId);
    intents.push({
      operationId: value.operationId,
      storedPath: value.storedPath,
      runtimePath: value.runtimePath,
      requestedAt: value.requestedAt,
      source: value.source,
    });
  }
  return { intents, malformed };
}

/**
 * The journal a write persists: the intents it decided on, followed by the
 * entries it could not read and therefore has no standing to remove.
 */
function composePendingWorkspaceRootRemovals(
  intents: readonly PendingWorkspaceRootRemoval[],
  malformed: readonly unknown[],
): unknown[] {
  return [...intents, ...malformed];
}

/**
 * Permission policy P3 — normalize `permissions.reviewer` from arbitrary JSON to the
 * canonical block. Unknown enum values fall back to defaults with a
 * warn (per CLAUDE.md No-Fallback: this is the *external boundary* —
 * settings file may be hand-edited with bad values).
 */
function normalizeReviewerBlock(parsed: unknown): ReviewerSettingsBlock {
  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_REVIEWER);
  const obj = parsed as Record<string, unknown>;
  const mode =
    typeof obj.mode === "string" && REVIEWER_MODES.has(obj.mode as ReviewerMode)
      ? (obj.mode as ReviewerMode)
      : DEFAULT_REVIEWER.mode;
  const provider =
    typeof obj.provider === "string" &&
    REVIEWER_PROVIDERS_SET.has(obj.provider as ReviewerProvider)
      ? (obj.provider as ReviewerProvider)
      : DEFAULT_REVIEWER.provider;
  const model =
    typeof obj.model === "string" && obj.model.length > 0
      ? obj.model
      : DEFAULT_REVIEWER.model;
  const fallbackOnError =
    typeof obj.fallbackOnError === "string" &&
    REVIEWER_FALLBACKS.has(obj.fallbackOnError as ReviewerFallbackOnError)
      ? (obj.fallbackOnError as ReviewerFallbackOnError)
      : DEFAULT_REVIEWER.fallbackOnError;
  const interactive = normalizeInteractiveBlock(obj.interactive);
  const parentAdjudication = normalizeParentAdjudicationBlock(obj.parentAdjudication);
  const disabledMigratedAt =
    typeof obj.disabledMigratedAt === "string" && obj.disabledMigratedAt.length > 0
      ? obj.disabledMigratedAt
      : undefined;
  return {
    mode,
    provider,
    model,
    fallbackOnError,
    interactive,
    parentAdjudication,
    disabledMigratedAt,
  };
}

/**
 * Clamp rather than reject out-of-range numbers: the settings file is an
 * external boundary a user may hand-edit, and both fields are ceilings whose
 * clamped value is still a safe posture. A non-finite or non-numeric value has
 * no clamped meaning at all, so it falls back to the default.
 */
function clampParentAdjudicationNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeParentAdjudicationBlock(
  parsed: unknown,
): ReviewerParentAdjudicationBlock {
  const fallback = DEFAULT_REVIEWER.parentAdjudication;
  if (!parsed || typeof parsed !== "object") return { ...fallback };
  const obj = parsed as Record<string, unknown>;
  const maxVerdict =
    typeof obj.maxVerdict === "string" &&
    PARENT_ADJUDICATION_MAX_VERDICTS.has(obj.maxVerdict as ParentAdjudicationMaxVerdict)
      ? (obj.maxVerdict as ParentAdjudicationMaxVerdict)
      : fallback.maxVerdict;
  const backgroundEscalation =
    typeof obj.backgroundEscalation === "string" &&
    PARENT_ADJUDICATION_BACKGROUND_ESCALATIONS.has(
      obj.backgroundEscalation as ParentAdjudicationBackgroundEscalation,
    )
      ? (obj.backgroundEscalation as ParentAdjudicationBackgroundEscalation)
      : fallback.backgroundEscalation;
  const model =
    typeof obj.model === "string" &&
    PARENT_ADJUDICATION_MODEL_SOURCES.has(obj.model as ParentAdjudicationModelSource)
      ? (obj.model as ParentAdjudicationModelSource)
      : fallback.model;
  return {
    maxVerdict,
    timeoutMs: clampParentAdjudicationNumber(
      obj.timeoutMs,
      fallback.timeoutMs,
      PARENT_ADJUDICATION_TIMEOUT_MS_MIN,
      PARENT_ADJUDICATION_TIMEOUT_MS_MAX,
    ),
    maxPerChildRun: clampParentAdjudicationNumber(
      obj.maxPerChildRun,
      fallback.maxPerChildRun,
      PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MIN,
      PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MAX,
    ),
    // Clamped like the other numbers, and to a deliberately short range: each
    // turn is a chunk of the user's conversation leaving the machine, so the
    // upper bound is a property of the feature rather than a matter of taste.
    includeParentContextTurns: clampParentAdjudicationNumber(
      obj.includeParentContextTurns,
      fallback.includeParentContextTurns,
      PARENT_ADJUDICATION_CONTEXT_TURNS_MIN,
      PARENT_ADJUDICATION_CONTEXT_TURNS_MAX,
    ),
    backgroundEscalation,
    model,
  };
}

function normalizeInteractiveBlock(parsed: unknown): ReviewerInteractiveBlock {
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_REVIEWER.interactive };
  }
  const obj = parsed as Record<string, unknown>;
  const autoApprove =
    typeof obj.autoApprove === "string" &&
    REVIEWER_INTERACTIVE_AUTO_APPROVES.has(obj.autoApprove as ReviewerInteractiveAutoApprove)
      ? (obj.autoApprove as ReviewerInteractiveAutoApprove)
      : DEFAULT_REVIEWER.interactive.autoApprove;
  return { autoApprove };
}

/**
 * Atomically rewrite `~/.lvis/settings.json` with a fresh
 * `permissions.additionalDirectories` value. Preserves any other
 * top-level keys present in the existing file.
 *
 * Permission policy P3: also accepts a `reviewer` patch (partial). Provided keys
 * overwrite; missing keys preserve existing values.
 */
export async function writePermissionSettings(
  patch: {
    additionalDirectories?: string[];
    reviewer?: Partial<ReviewerSettingsBlock>;
  },
  pathOverride?: string,
): Promise<void> {
  const filePath = pathOverride ?? defaultPath();
  await withFileLock(filePath, async () => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = (existing.permissions ?? {}) as Record<string, unknown>;
    // Drop the deprecated alias key on write — settings file converges
    // on the canonical name with each persist.
    delete existingPerm.allowedDirectories;
    const existingReviewer = normalizeReviewerBlock(existingPerm.reviewer);
    const nextReviewer: ReviewerSettingsBlock = patch.reviewer
      ? validateReviewerPatch({ ...existingReviewer, ...patch.reviewer })
      : existingReviewer;
    const nextDirs =
      patch.additionalDirectories !== undefined
        ? [...patch.additionalDirectories]
        : Array.isArray(existingPerm.additionalDirectories)
          ? (existingPerm.additionalDirectories as string[])
          : [];
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: nextDirs,
        reviewer: nextReviewer,
      },
    };
    writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
  });
}

/**
 * Strict validate a candidate reviewer block. Used by the slash
 * handler / IPC writes — invalid input rejected with an error message
 * (no silent default-substitution at write time, only at read time
 * for hand-edited files).
 */
function validateReviewerPatch(patch: ReviewerSettingsBlock): ReviewerSettingsBlock {
  if (!REVIEWER_MODES.has(patch.mode)) {
    throw new Error(
      `permissions.reviewer.mode invalid: '${patch.mode}'. Allowed: ${[...REVIEWER_MODES].join("|")}`,
    );
  }
  if (!REVIEWER_PROVIDERS_SET.has(patch.provider)) {
    throw new Error(
      `permissions.reviewer.provider invalid: '${patch.provider}'. Allowed: ${REVIEWER_PROVIDERS.join("|")}`,
    );
  }
  if (!REVIEWER_FALLBACKS.has(patch.fallbackOnError)) {
    throw new Error(
      `permissions.reviewer.fallbackOnError invalid: '${patch.fallbackOnError}'. Allowed: ${[...REVIEWER_FALLBACKS].join("|")}`,
    );
  }
  if (typeof patch.model !== "string" || patch.model.length === 0) {
    throw new Error("permissions.reviewer.model must be a non-empty string");
  }
  if (
    !patch.interactive ||
    !REVIEWER_INTERACTIVE_AUTO_APPROVES.has(patch.interactive.autoApprove)
  ) {
    throw new Error(
      `permissions.reviewer.interactive.autoApprove invalid: '${patch.interactive?.autoApprove}'. ` +
      `Allowed: ${[...REVIEWER_INTERACTIVE_AUTO_APPROVES].join("|")}`,
    );
  }
  return patch;
}

/**
 * Permission policy P3 — persist a reviewer-block partial. Convenience helper for
 * `/permission reviewer ...` slash dispatchers.
 */
export async function setReviewerSettingsPersist(
  patch: Partial<ReviewerSettingsBlock>,
  pathOverride?: string,
): Promise<ReviewerSettingsBlock> {
  await writePermissionSettings({ reviewer: patch }, pathOverride);
  return readPermissionSettings(pathOverride).permissions.reviewer;
}

/**
 * Resolve an existing directory to the identity that is persisted in the
 * permission SOT. Keeping the real path (instead of a symlink alias) freezes the
 * authorized target even if that alias is later removed or retargeted.
 *
 * Legacy/non-existent values are kept verbatim so hand-edited settings and the
 * slash-command parser retain their existing behaviour; workspace IPC validates
 * existence before calling this helper.
 */
function persistedAllowedDirectory(dir: string): string {
  if (dir.trim().length === 0) return dir;
  const resolved = pathResolve(dir);
  return existsSync(resolved) ? canonicalizePathForMatch(resolved) : dir;
}

function allowedDirectoryKey(dir: string): string | null {
  if (dir.trim().length === 0) return null;
  try {
    return caseFoldForMatch(canonicalizePathForMatch(pathResolve(dir)));
  } catch {
    return null;
  }
}

async function mutateAllowedDirectoriesPersist(
  mutation: (
    current: string[],
    pending: readonly PendingWorkspaceRootRemoval[],
  ) => string[],
  pathOverride?: string,
): Promise<string[]> {
  const filePath = pathOverride ?? defaultPath();
  let result: string[] = [];
  await withFileLock(filePath, async () => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const next = mutation(current, journal.intents);
    result = [...next];
    if (
      next.length === current.length &&
      next.every((value, index) => value === current[index])
    ) {
      return;
    }
    delete existingPerm.allowedDirectories;
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: next,
        reviewer: normalizeReviewerBlock(existingPerm.reviewer),
      },
    };
    writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
  });
  return result;
}

/**
 * Append a directory to `permissions.additionalDirectories`. Persists
 * via {@link writePermissionSettings}. De-duplicates by exact string.
 *
 * Returns the post-add list (caller may show in toast).
 */
export async function addAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  const stored = persistedAllowedDirectory(dir);
  return mutateAllowedDirectoriesPersist((list, pending) => {
    const targetKey = allowedDirectoryKey(stored);
    if (
      targetKey !== null
      && pending.some((intent) => allowedDirectoryKey(intent.runtimePath) === targetKey)
    ) {
      throw Object.assign(new Error("workspace-root-removal-pending"), {
        code: "WORKSPACE_ROOT_REMOVAL_PENDING",
      });
    }
    if (
      list.some((entry) =>
        targetKey === null ? entry === stored : allowedDirectoryKey(entry) === targetKey,
      )
    ) {
      return list;
    }
    return [...list, stored];
  }, pathOverride);
}

/**
 * Remove a directory from `permissions.additionalDirectories`. Returns
 * the post-removal list. No-op when the dir is not present.
 */
export async function removeAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  return mutateAllowedDirectoriesPersist((list) => {
    const targetKey = allowedDirectoryKey(dir);
    return list.filter((entry) =>
      targetKey === null ? entry !== dir : allowedDirectoryKey(entry) !== targetKey,
    );
  }, pathOverride);
}

function isCommittedAtomicWriteError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "committed" in error
    && (error as { committed?: unknown }).committed === true,
  );
}

export interface BeginWorkspaceRootRemovalResult {
  intent: PendingWorkspaceRootRemoval;
  activeDirectories: string[];
  created: boolean;
}

/**
 * Atomically cut a registered root out of the active allow-list and append a
 * durable cleanup intent. A matching pending operation is returned on retry.
 */
export async function beginWorkspaceRootRemovalPersist(
  root: string,
  source: string,
  pathOverride?: string,
): Promise<BeginWorkspaceRootRemovalResult | null> {
  const filePath = pathOverride ?? defaultPath();
  let result: BeginWorkspaceRootRemovalResult | null = null;
  await withFileLock(filePath, async () => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const pending = journal.intents;
    const targetKey = allowedDirectoryKey(root);
    const existingIntent = pending.find((intent) =>
      targetKey === null
        ? intent.runtimePath === root || intent.storedPath === root
        : allowedDirectoryKey(intent.runtimePath) === targetKey,
    );
    const storedPath = current.find((candidate) =>
      targetKey === null ? candidate === root : allowedDirectoryKey(candidate) === targetKey,
    );
    if (!storedPath) {
      if (existingIntent) {
        result = { intent: existingIntent, activeDirectories: [...current], created: false };
      }
      return;
    }

    const runtimePath = canonicalizePathForMatch(pathResolve(storedPath));
    const runtimeKey = allowedDirectoryKey(runtimePath);
    const intent = existingIntent ?? {
      operationId: randomUUID(),
      storedPath,
      runtimePath,
      requestedAt: new Date().toISOString(),
      source,
    };
    const activeDirectories = current.filter((candidate) =>
      runtimeKey === null
        ? candidate !== storedPath
        : allowedDirectoryKey(candidate) !== runtimeKey,
    );
    const nextPending = existingIntent ? pending : [...pending, intent];
    delete existingPerm.allowedDirectories;
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: activeDirectories,
        pendingWorkspaceRootRemovals: composePendingWorkspaceRootRemovals(
          nextPending,
          journal.malformed,
        ),
        reviewer: normalizeReviewerBlock(existingPerm.reviewer),
      },
    };
    try {
      writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
    } catch (error: unknown) {
      if (!isCommittedAtomicWriteError(error)) throw error;
      const verified = readPermissionSettings(filePath).permissions;
      const intentCommitted = verified.pendingWorkspaceRootRemovals.some(
        (candidate) => candidate.operationId === intent.operationId,
      );
      const rootInactive = !verified.additionalDirectories.some(
        (candidate) => runtimeKey !== null && allowedDirectoryKey(candidate) === runtimeKey,
      );
      if (!intentCommitted || !rootInactive) throw error;
    }
    result = { intent, activeDirectories, created: !existingIntent };
  });
  return result;
}

/** Complete one exact operation; stale operation IDs are ABA-safe no-ops. */
export async function completeWorkspaceRootRemovalPersist(
  operationId: string,
  pathOverride?: string,
): Promise<boolean> {
  const filePath = pathOverride ?? defaultPath();
  let completed = false;
  await withFileLock(filePath, async () => {
    const existing = readSettingsObjectForUpdate(filePath);
    const existingPerm = { ...((existing.permissions ?? {}) as Record<string, unknown>) };
    const journal = partitionPendingWorkspaceRootRemovals(
      existingPerm.pendingWorkspaceRootRemovals,
    );
    const pending = journal.intents;
    const intent = pending.find((candidate) => candidate.operationId === operationId);
    if (!intent) return;
    const intentKey = allowedDirectoryKey(intent.runtimePath);
    const current = Array.isArray(existingPerm.additionalDirectories)
      ? existingPerm.additionalDirectories.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const activeDirectories = current.filter((candidate) =>
      intentKey === null
        ? candidate !== intent.storedPath
        : allowedDirectoryKey(candidate) !== intentKey,
    );
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: activeDirectories,
        pendingWorkspaceRootRemovals: composePendingWorkspaceRootRemovals(
          pending.filter((candidate) => candidate.operationId !== operationId),
          journal.malformed,
        ),
        reviewer: normalizeReviewerBlock(existingPerm.reviewer),
      },
    };
    try {
      writeUtf8FileAtomicSync(filePath, JSON.stringify(merged, null, 2), 0o600);
    } catch (error: unknown) {
      if (!isCommittedAtomicWriteError(error)) throw error;
      const verified = readPermissionSettings(filePath).permissions;
      const intentGone = !verified.pendingWorkspaceRootRemovals.some(
        (candidate) => candidate.operationId === operationId,
      );
      const rootInactive = !verified.additionalDirectories.some(
        (candidate) => intentKey !== null && allowedDirectoryKey(candidate) === intentKey,
      );
      if (!intentGone || !rootInactive) throw error;
    }
    completed = true;
  });
  return completed;
}
