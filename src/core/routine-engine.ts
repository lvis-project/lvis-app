/**
 * RoutineEngine — routine execution engine.
 *
 * Each routine fire creates a dedicated ConversationLoop instance so routine
 * sessions are isolated from the interactive main loop while using the same
 * session repository and metadata model.
 */
import type { ConversationLoop } from "../engine/conversation-loop.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import type { RoutineScope } from "../shared/routines-types.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
const log = createLogger("routine-engine");

export interface Routine {
  id: string;
  trigger: "shutdown" | "schedule";
  prePrompt: string;
  title?: string;
  /**
   * Permission policy Layer 4 — fully resolved scope (no `inherit` left). Boot-time
   * normalization in the dispatcher snapshots the active plugin set
   * before this method runs.
   */
  scope?: RoutineScope;
  firedAt?: string;
  /**
   * Optional abort signal. When signalled (e.g. shutdown timeout), the
   * underlying ConversationLoop.runTurn is aborted rather than only dropping
   * the Promise.race winner while the turn continues running.
   */
  signal?: AbortSignal;
}

export interface RoutineResult {
  routineId: string;
  trigger: "shutdown" | "schedule";
  summary: string;
  generatedAt: string;
  sessionId?: string;
}

export interface RoutineEngineDeps {
  /** Called once per routine fire to produce a fresh, isolated ConversationLoop. */
  createConversationLoop: (input: Routine) => ConversationLoop;
  /**
   * Permission policy Layer 4 — invoked at routine fire time to snapshot the
   * currently-active plugin set. Used to translate
   * `scope.pluginIds.mode === "inherit"` into a concrete `allow` list
   * BEFORE the conversation loop is constructed, so the loop never
   * sees `inherit`. When omitted, `inherit` falls back to deny-all
   * (defensive — pre-Permission policy boot wires this dep for production).
   */
  getActivePluginIds?: () => string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the content of the first <summary>…</summary> tag from a routine
 * LLM response. The system prompt (ROUTINE_SUMMARY_TAG_INSTRUCTION) mandates
 * this tag at the end of every routine turn.
 *
 * Tag absence means the LLM violated the system prompt format — returns the
 * explicit "summary format missing" marker so users and developers immediately notice
 * the missing annotation rather than silently getting a truncated body.
 *
 * Caps extracted content at 200 codepoints (OverlayCard surface budget).
 */
function extractSummaryTag(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!match) {
    return t("be_routineEngine.summaryTagMissing");
  }
  const content = match[1].trim();
  const codepoints = [...content];
  return codepoints.length <= 200 ? content : codepoints.slice(0, 200).join("");
}

export class RoutineEngine {
  private readonly activeLoops = new Set<ConversationLoop>();
  private readonly workspaceRootPolicy = new Map<
    string,
    { allowed: boolean; sequence: number }
  >();
  private workspaceRootPolicySequence = 0;

  constructor(private readonly deps: RoutineEngineDeps) {}

  private workspaceRootKey(root: string): string | null {
    try {
      const key = caseFoldForMatch(canonicalizePathForMatch(root)).replace(/\/+$/g, "");
      return key || "/";
    } catch {
      return null;
    }
  }

  private static isAtOrBelow(root: string, candidate: string): boolean {
    return candidate === root || (root === "/"
      ? candidate.startsWith("/")
      : candidate.startsWith(`${root}/`));
  }

  private recordWorkspaceRootPolicy(root: string, allowed: boolean): string | null {
    const key = this.workspaceRootKey(root);
    if (!key) return null;
    this.workspaceRootPolicy.set(key, {
      allowed,
      sequence: ++this.workspaceRootPolicySequence,
    });
    return key;
  }

  private isWorkspaceDirectoryRevoked(directory: string): boolean {
    const candidate = this.workspaceRootKey(directory);
    if (!candidate) return this.workspaceRootPolicy.size > 0;
    let latest: { allowed: boolean; sequence: number } | null = null;
    for (const [root, policy] of this.workspaceRootPolicy) {
      if (!RoutineEngine.isAtOrBelow(root, candidate)) continue;
      if (!latest || policy.sequence > latest.sequence) latest = policy;
    }
    return latest?.allowed === false;
  }

  /** Allow a newly registered root for future routine fires. */
  allowWorkspaceRoot(root: string): void {
    this.recordWorkspaceRootPolicy(root, true);
  }

  /** Revoke a root from live loops and stale future-fire scope snapshots. */
  revokeWorkspaceRoot(
    root: string,
    options?: {
      preserveRoots?: readonly string[];
      globalScopeWasAuthorized?: boolean;
    },
  ): {
    activeLoopsVisited: number;
    liveScopesRevoked: number;
  } {
    const canonicalRoot = this.recordWorkspaceRootPolicy(root, false);
    if (!canonicalRoot) return { activeLoopsVisited: 0, liveScopesRevoked: 0 };
    const preservedRoots = [...new Set(
      (options?.preserveRoots ?? [])
        .map((preserveRoot) => this.workspaceRootKey(preserveRoot))
        .filter((preserveRoot): preserveRoot is string =>
          preserveRoot !== null
          && preserveRoot !== canonicalRoot
          && RoutineEngine.isAtOrBelow(canonicalRoot, preserveRoot),
        ),
    )];
    // A separately registered descendant is a narrower, later policy override:
    // the parent stays denied while the child remains eligible for future fires.
    for (const preserveRoot of preservedRoots) {
      this.recordWorkspaceRootPolicy(preserveRoot, true);
    }
    let activeLoopsVisited = 0;
    let liveScopesRevoked = 0;
    for (const loop of [...this.activeLoops]) {
      activeLoopsVisited += 1;
      try {
        const result = loop.revokeWorkspaceRoot(canonicalRoot, {
          preserveRoots: preservedRoots,
          globalScopeWasAuthorized: options?.globalScopeWasAuthorized,
        });
        liveScopesRevoked += result.sessionDirectoriesRemoved + result.turnDirectoriesRemoved;
      } catch (error: unknown) {
        log.warn(
          "routine workspace scope revocation failed (%s)",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return { activeLoopsVisited, liveScopesRevoked };
  }

  /**
   * Permission policy Layer 4 — snapshot `inherit` to a concrete allow-list at fire
   * time. The loop must never see `inherit`; downstream
   * `createRoutineConversationLoop` defensively coerces `inherit` to
   * deny-all, but the principled spot is here where we still have
   * access to the host's active plugin set.
   */
  private normalizeScope(scope: RoutineScope | undefined): RoutineScope {
    if (!scope) {
      return {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [],
      };
    }
    const active = scope.pluginIds.mode === "inherit"
      ? (this.deps.getActivePluginIds?.() ?? [])
      : [];
    return {
      pluginIds: scope.pluginIds.mode === "inherit"
        ? (active.length > 0
            ? { mode: "allow", ids: [...active] }
            : { mode: "deny-all" })
        : (scope.pluginIds.mode === "allow"
            ? { mode: "allow", ids: [...scope.pluginIds.ids] }
            : { mode: "deny-all" }),
      forcedPluginIds: [...scope.forcedPluginIds],
      directories: scope.directories.filter(
        (directory) => !this.isWorkspaceDirectoryRevoked(directory),
      ),
    };
  }

  async runRoutine(input: Routine): Promise<RoutineResult> {
    const generatedAt = new Date().toISOString();
    // Permission policy Layer 4 — normalize scope BEFORE building the loop so the
    // loop never observes `inherit`. `inherit` snapshots the active
    // plugin set at fire time; missing scope falls back to deny-all
    // (the safe default for headless routine sessions).
    const normalizedInput: Routine = {
      ...input,
      scope: this.normalizeScope(input.scope),
    };
    // Each fire gets its own loop — no history sharing with main chat.
    const loop = this.deps.createConversationLoop(normalizedInput);
    this.activeLoops.add(loop);
    try {
      const sessionId = await loop.startRoutineConversation(
        input.id,
        input.title ?? input.id,
        input.firedAt ?? generatedAt,
      );

      let summary = "";
      try {
        const result = await loop.runTurn(input.prePrompt, undefined, input.signal, {
          inputOrigin: "plugin-emitted",
        });
        summary = extractSummaryTag(result.text ?? "");
      } catch (err) {
        log.warn("runRoutine error (id=%s): %s", input.id, err instanceof Error ? err.message : String(err));
        summary = t("be_routineEngine.runRoutineError", { message: err instanceof Error ? err.message : String(err) });
      }

      return {
        routineId: input.id,
        trigger: input.trigger,
        summary,
        generatedAt,
        sessionId,
      };
    } finally {
      this.activeLoops.delete(loop);
      // Clear this session's on-demand plugin activations from PluginRuntime.
      // The routine loop is discarded after runTurn completes and never calls
      // resetSession, so without this call the per-session Map entry would
      // accumulate as a stale entry in the PluginRuntime singleton.
      loop.cleanupSession();
    }
  }
}
