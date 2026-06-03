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
/**
 * 턴당 tool_search 허용 횟수. request_plugin (2) 보다 넉넉 — tool_search 는
 * deferral 모드의 *주 발견 경로*라 한 턴에 여러 도구 묶음을 promote 할 수 있다.
 */
export const MAX_TOOL_SEARCH_PER_TURN = 4;
/** 세션당 tool_search 누적 허용 횟수. */
export const MAX_TOOL_SEARCH_PER_SESSION = 20;
/** 검색 1회가 promote 할 수 있는 최대 도구 수. Broad query TPM 폭증 방지. */
export const MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH = 3;
/**
 * Catalog 매칭에 기여할 수 있는 최소 토큰 길이. 이보다 짧은 토큰 (예: 1글자
 * `m`, `a`) 은 `name.includes` / `description.includes` 로 거의 모든 카탈로그
 * 항목과 매치되어 over-promotion 을 유발하므로 점수화 단계에서 제외한다.
 * query tokenization 과 catalog scoring 양쪽에서 동일 SOT 로 강제한다.
 */
export const MIN_CATALOG_MATCH_TOKEN_LENGTH = 2;

/** Catalog entry the loop supplies (from `getToolCatalogForScope`). */
export interface ToolSearchCatalogEntry {
  name: string;
  description: string;
}

export interface ToolSearchState {
  /** 이번 턴에서 이미 성공한 tool_search 횟수. */
  turnSearches: number;
  /** 세션 누적 성공 횟수. */
  sessionSearches: number;
  /** 이번 턴 scope 에 로드된 tool name (mutation 가능). */
  activeToolNames: Set<string>;
  /** 현재 provider `tools[]`에 이미 노출된 full-schema tool names. */
  loadedToolNames?: Set<string>;
  /** 현재 provider `tools[]`에 이미 노출된 full-schema tools. */
  loadedTools?: ToolSearchCatalogEntry[];
  /** 현재 catalog (아직 로드되지 않은 in-scope plugin/mcp tool). */
  catalog: ToolSearchCatalogEntry[];
}

export interface ToolSearchOutcome {
  /** 합성된 tool_result 들 — 호출자가 history 에 append. */
  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
  /** tool_search 이외의 실제 실행할 tool_use. */
  remaining: ToolUseBlock[];
  /** promote 에 성공한 tool name 목록 — 호출자가 toolSchemas rebuild 신호로 사용. */
  promotedToolNames: string[];
  /** tool_search asked for a tool that is already present in provider tools[]. */
  alreadyLoadedToolNames: string[];
  /** 갱신된 턴 카운터. */
  nextTurnSearches: number;
  /** 갱신된 세션 카운터. */
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

function scoreCatalogEntry(
  query: string,
  tokens: string[],
  entry: ToolSearchCatalogEntry,
): number {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const nameTokens = tokenizeName(entry.name);
  // Exact whole-query name match still requires the query to clear the minimum
  // token length so a 1-char query cannot promote a 1-char tool name.
  let score = name === query && query.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH ? 1_000 : 0;

  for (const token of tokens) {
    // Defense at the scoring boundary: sub-minimum tokens never contribute,
    // even if a future caller bypasses tokenizeQuery's length filter.
    if (token.length < MIN_CATALOG_MATCH_TOKEN_LENGTH) continue;
    if (name === token) {
      score += 700;
    } else if (name.startsWith(token)) {
      score += 350;
    } else if (nameTokens.includes(token)) {
      score += 300;
    } else if (name.includes(token)) {
      score += 120;
    }

    if (description.includes(token)) {
      score += 30;
    }
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

/**
 * query 에 매치되는 catalog tool 을 점수화해 상위 N개만 반환한다.
 * Broad substring query 가 activeToolNames 를 대량 확장하지 못하도록
 * exact/name-token match 를 description hit 보다 강하게 두고 promotion
 * 수를 고정 상한으로 제한한다.
 */
function matchCatalog(
  query: string,
  catalog: ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  return catalog
    .map((entry) => ({ entry, score: scoreCatalogEntry(normalizedQuery, tokens, entry) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH)
    .map((candidate) => candidate.entry);
}

/**
 * tool_use 목록을 훑어 tool_search 를 인터셉트하고 나머지는 통과시킨다.
 *
 * @param toolUses LLM 이 요청한 tool_use 블록들
 * @param state 현재 카운터 + active tool set + catalog
 */
export function handleToolSearch(
  toolUses: ToolUseBlock[],
  state: ToolSearchState,
): ToolSearchOutcome {
  const results: ToolSearchOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const promotedToolNames: string[] = [];
  const alreadyLoadedToolNames: string[] = [];
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
        alreadyLoadedToolNames.push(exactLoaded.name);
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
            for (const match of loadedMatches) alreadyLoadedToolNames.push(match.name);
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
    alreadyLoadedToolNames,
    nextTurnSearches: turnSearches,
    nextSessionSearches: sessionSearches,
  };
}
