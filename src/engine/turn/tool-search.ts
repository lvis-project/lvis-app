/**
 * Tool-Level Deferral — `tool_search` meta-tool handler.
 *
 * Mirror of `plugin-expansion.ts` (`request_plugin`) one layer down: where
 * `request_plugin` promotes a whole *plugin* into scope, `tool_search`
 * promotes individual *tools* from the per-turn catalog into the live
 * `tools[]` for the next round.
 *
 * When the LLM emits `tool_search({ query })` the ConversationLoop does not
 * pass it to the tool executor; instead this module ranks catalog tools by
 * `query`, promotes a small top-N result set into
 * `activeToolNames`, and synthesizes a `tool_result` per intercepted
 * `tool_use` (tool-pair invariant). The caller rebuilds tool schemas and
 * refunds the round, exactly like the plugin path.
 *
 * Pure logic — the caller owns side effects (history append, schema rebuild).
 */
import type { ToolUseBlock } from "../../tools/executor.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { createLogger } from "../../lib/logger.js";
import { t } from "../../i18n/index.js";
const log = createLogger("lvis");

/** Name of the meta-tool. SOT is the registry; re-exported here for the loop. */
export const TOOL_SEARCH_TOOL = TOOL_SEARCH_TOOL_NAME;



export const MAX_TOOL_SEARCH_PER_TURN = 4;

export const MAX_TOOL_SEARCH_PER_SESSION = 20;

export const MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH = 5;



export const MIN_CATALOG_MATCH_TOKEN_LENGTH = 2;

/** Catalog entry the loop supplies (from `getToolCatalogForScope`). */
export interface ToolSearchCatalogEntry {
  name: string;
  description: string;
}

export interface ToolSearchState {

  turnSearches: number;

  sessionSearches: number;

  activeToolNames: Set<string>;

  loadedToolNames?: Set<string>;

  loadedTools?: ToolSearchCatalogEntry[];

  catalog: ToolSearchCatalogEntry[];
}

export interface ToolSearchOutcome {

  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  promotedToolNames: string[];

  nextTurnSearches: number;

  nextSessionSearches: number;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  if (normalized.length === 0) return [];
  return uniqueStrings([
    normalized,
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|]+/),
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|_-]+/),
  ].map((t) => t.trim()).filter((t) => t.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH));
}

function tokenizeName(name: string): string[] {
  return name.toLowerCase().split(/[_\-\s.]+/).filter((t) => t.length > 0);
}

function entrySearchText(entry: ToolSearchCatalogEntry): string {
  return `${entry.name} ${entry.description}`.toLowerCase();
}

/**
 * IDF weight per query token over the current catalog corpus: a rare token
 * weighs ~1.0, a token that appears in most entries (get/list/file) is damped
 * toward a 0.2 floor (kept above 0 so a common-token match still counts).
 * Normalized by log(1+N) so the range is stable regardless of catalog size and
 * clamped to [0.2, 1]. This is the discriminative core of the ranking upgrade:
 * a match on a distinctive token now outranks a match on boilerplate.
 */
function computeIdfWeights(
  catalog: ToolSearchCatalogEntry[],
  queryTokens: string[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = catalog.length;
  if (total === 0) return weights;
  const texts = catalog.map(entrySearchText);
  const denom = Math.log(1 + total) || 1;
  for (const token of queryTokens) {
    if (weights.has(token)) continue;
    let documentFrequency = 0;
    for (const text of texts) {
      if (text.includes(token)) documentFrequency += 1;
    }
    const idf = documentFrequency > 0 ? Math.log(1 + total / documentFrequency) : Math.log(1 + total);
    weights.set(token, Math.min(1, Math.max(0.2, idf / denom)));
  }
  return weights;
}

function scoreCatalogEntry(
  query: string,
  tokens: string[],
  entry: ToolSearchCatalogEntry,
  idfWeights?: Map<string, number>,
): number {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const nameTokens = tokenizeName(entry.name);
  // Exact whole-query name match is an un-weighted strong signal (still requires
  // the query to clear the minimum token length so a 1-char query cannot promote
  // a 1-char tool name).
  let score = name === query && query.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH ? 1_000 : 0;

  for (const token of tokens) {
    // Defense at the scoring boundary: sub-minimum tokens never contribute,
    // even if a future caller bypasses tokenizeQuery's length filter.
    if (token.length < MIN_CATALOG_MATCH_TOKEN_LENGTH) continue;
    let tokenScore = 0;
    if (name === token) {
      tokenScore = 700;
    } else if (name.startsWith(token)) {
      tokenScore = 350;
    } else if (nameTokens.includes(token)) {
      tokenScore = 300;
    } else if (name.includes(token)) {
      tokenScore = 120;
    }

    if (description.includes(token)) {
      tokenScore += 30;
    }

    // IDF weighting: dampen contributions from tokens common across the catalog.
    // Absent weights (default 1) preserve the pre-IDF behavior.
    score += tokenScore * (idfWeights?.get(token) ?? 1);
  }

  return score;
}

/**
 * Test-only export — allows unit tests to drive `scoreCatalogEntry` directly
 * so the scoring-side MIN_CATALOG_MATCH_TOKEN_LENGTH guards (lines above) are
 * covered independently of the tokenizeQuery pre-filter. The function is pure
 * and has no side effects; exporting it does not affect production behaviour.
 *
 * @internal Do not import outside of `__tests__/`.
 */
export { scoreCatalogEntry as _scoreCatalogEntryForTest };
/** @internal Test-only — IDF weighting is pure; do not import outside `__tests__/`. */
export { computeIdfWeights as _computeIdfWeightsForTest };




function matchCatalog(
  query: string,
  catalog: ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const idfWeights = computeIdfWeights(catalog, tokens);
  return catalog
    .map((entry) => ({ entry, score: scoreCatalogEntry(normalizedQuery, tokens, entry, idfWeights) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH)
    .map((candidate) => candidate.entry);
}




export function handleToolSearch(
  toolUses: ToolUseBlock[],
  state: ToolSearchState,
): ToolSearchOutcome {
  const results: ToolSearchOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const promotedToolNames: string[] = [];
  let turnSearches = state.turnSearches;
  let sessionSearches = state.sessionSearches;

  for (const tu of toolUses) {
    if (tu.name !== TOOL_SEARCH_TOOL) {
      remaining.push(tu);
      continue;
    }
    const query = (tu.input as { query?: unknown })?.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryRequired"),
        is_error: true,
      });
    } else if (tokenizeQuery(query).length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryTokenTooShort", { minLen: String(MIN_CATALOG_MATCH_TOKEN_LENGTH) }),
        is_error: true,
      });
    } else if (turnSearches >= MAX_TOOL_SEARCH_PER_TURN) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.turnLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_TURN), query }),
        is_error: true,
      });
    } else if (sessionSearches >= MAX_TOOL_SEARCH_PER_SESSION) {
      log.warn(
        `tool_search session cap reached (${MAX_TOOL_SEARCH_PER_SESSION}). ` +
        `Rejecting query '${query}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.sessionLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_SESSION), query }),
        is_error: true,
      });
    } else {
      const normalizedQuery = query.trim().toLowerCase();
      const loadedCatalog = state.loadedTools ?? [...(state.loadedToolNames ?? state.activeToolNames)]
        .map((name) => ({ name, description: "" }));
      const exactLoaded = loadedCatalog.find(
        (tool) => tool.name.toLowerCase() === normalizedQuery,
      );
      if (exactLoaded) {
        results.push({
          tool_use_id: tu.id,
          content: t("be_toolSearch.alreadyLoaded", { name: exactLoaded.name }),
          is_error: false,
        });
      } else {
        const matches = matchCatalog(query, state.catalog).filter(
          (m) => !state.activeToolNames.has(m.name),
        );
        if (matches.length === 0) {
          const loadedMatches = matchCatalog(query, loadedCatalog);
          if (loadedMatches.length > 0) {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.alreadyLoadedMultiple", { names: loadedMatches.map((m) => m.name).join(", ") }),
              is_error: false,
            });
          } else {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.noMatchFound", {
                query,
                catalog: state.catalog.map((c) => c.name).join(", ") || t("be_toolSearch.catalogEmpty"),
              }),
              is_error: true,
            });
          }
        } else {
          for (const m of matches) {
            state.activeToolNames.add(m.name);
            promotedToolNames.push(m.name);
          }
          turnSearches += 1;
          sessionSearches += 1;
          results.push({
            tool_use_id: tu.id,
            content: t("be_toolSearch.toolsPromoted", { count: String(matches.length), names: matches.map((m) => m.name).join(", ") }),
            is_error: false,
          });
        }
      }
    }
  }

  return {
    results,
    remaining,
    promotedToolNames,
    nextTurnSearches: turnSearches,
    nextSessionSearches: sessionSearches,
  };
}
