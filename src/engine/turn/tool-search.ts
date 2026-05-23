/**
 * Tool-Level Deferral — `tool_search` meta-tool handler.
 *
 * Mirror of `plugin-expansion.ts` (`request_plugin`) one layer down: where
 * `request_plugin` promotes a whole *plugin* into scope, `tool_search`
 * promotes individual *tools* from the per-turn catalog into the live
 * `tools[]` for the next round.
 *
 * When the LLM emits `tool_search({ query })` the ConversationLoop does not
 * pass it to the tool executor; instead this module matches catalog tools by
 * `query` (substring over name + description), adds the matches to
 * `activeToolNames`, and synthesizes a `tool_result` per intercepted
 * `tool_use` (tool-pair invariant). The caller rebuilds tool schemas and
 * refunds the round, exactly like the plugin path.
 *
 * Pure logic — the caller owns side effects (history append, schema rebuild).
 */
import type { ToolUseBlock } from "../../tools/executor.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { createLogger } from "../../lib/logger.js";
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
  /** 갱신된 턴 카운터. */
  nextTurnSearches: number;
  /** 갱신된 세션 카운터. */
  nextSessionSearches: number;
}

/**
 * query 에 매치되는 catalog tool 을 찾는다. name/description 부분 문자열 매치
 * (대소문자 무시). query 의 공백 분리 토큰 중 *하나라도* name 또는 description
 * 에 포함되면 매치 — 모델이 자연어 query 를 줘도 도구를 잡아낼 수 있게 한다.
 */
function matchCatalog(
  query: string,
  catalog: ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  return catalog.filter((entry) => {
    const haystack = `${entry.name} ${entry.description}`.toLowerCase();
    return tokens.some((tok) => haystack.includes(tok));
  });
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
        content: "tool_search 오류: query (string) 필수.",
        is_error: true,
      });
    } else if (turnSearches >= MAX_TOOL_SEARCH_PER_TURN) {
      results.push({
        tool_use_id: tu.id,
        content: `tool_search 한도 초과 (턴당 최대 ${MAX_TOOL_SEARCH_PER_TURN}회). '${query}' 검색 거부.`,
        is_error: true,
      });
    } else if (sessionSearches >= MAX_TOOL_SEARCH_PER_SESSION) {
      log.warn(
        `tool_search session cap reached (${MAX_TOOL_SEARCH_PER_SESSION}). ` +
        `Rejecting query '${query}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: `tool_search 세션 한도 초과 (세션당 최대 ${MAX_TOOL_SEARCH_PER_SESSION}회). '${query}' 검색 거부.`,
        is_error: true,
      });
    } else {
      const matches = matchCatalog(query, state.catalog).filter(
        (m) => !state.activeToolNames.has(m.name),
      );
      if (matches.length === 0) {
        results.push({
          tool_use_id: tu.id,
          content:
            `'${query}' 에 매치되는 미로드 도구 없음. ` +
            `현재 카탈로그: ${state.catalog.map((c) => c.name).join(", ") || "(없음)"}`,
          is_error: true,
        });
      } else {
        for (const m of matches) {
          state.activeToolNames.add(m.name);
          promotedToolNames.push(m.name);
        }
        turnSearches += 1;
        sessionSearches += 1;
        results.push({
          tool_use_id: tu.id,
          content: `${matches.length}개 도구 로드됨: ${matches.map((m) => m.name).join(", ")}.`,
          is_error: false,
        });
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
