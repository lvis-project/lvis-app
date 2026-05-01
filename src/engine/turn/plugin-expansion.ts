/**
 * Phase 1.5 Option C — `request_plugin` 메타 툴 처리.
 *
 * LLM 이 tool_use 로 `request_plugin({pluginId})` 를 요청하면 실제 tool executor
 * 에 넘기지 않고 이 모듈이 scope 를 확장하거나 에러 결과를 합성한다.
 *
 * 순수 로직 — 호출자가 side-effect (history append, tool schema rebuild) 을 담당.
 */
import type { ToolUseBlock } from "../../tools/executor.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export const REQUEST_PLUGIN_TOOL = "request_plugin";
/** 턴당 request_plugin 허용 횟수. */
export const MAX_PLUGIN_EXPANSION = 2;
/** 세션당 request_plugin 누적 허용 횟수 (M2). */
export const MAX_SESSION_PLUGIN_EXPANSION = 6;

export interface PluginExpansionState {
  /** 이번 턴에서 이미 성공한 request_plugin 횟수. */
  turnExpansions: number;
  /** 세션 누적 성공 횟수. */
  sessionExpansions: number;
  /** 이번 턴 scope 에 활성화된 plugin id (mutation 가능). */
  activePluginIds: Set<string>;
  /** 실제 등록된 plugin id 목록 (런타임 질의 결과). */
  availablePluginIds: string[];
}

export interface PluginExpansionOutcome {
  /** 합성된 tool_result 들 — 호출자가 history 에 append. */
  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
  /** request_plugin 이외의 실제 실행할 tool_use. */
  remaining: ToolUseBlock[];
  /** 활성화에 성공한 pluginId 목록 — 호출자가 toolSchemas rebuild 신호로 사용. */
  activatedPluginIds: string[];
  /** 갱신된 턴 카운터. */
  nextTurnExpansions: number;
  /** 갱신된 세션 카운터. */
  nextSessionExpansions: number;
}

/**
 * tool_use 목록을 훑어 request_plugin 을 인터셉트하고 나머지는 통과시킨다.
 *
 * @param toolUses LLM 이 요청한 tool_use 블록들
 * @param state 현재 카운터 + active scope
 */
export function handleRequestPlugin(
  toolUses: ToolUseBlock[],
  state: PluginExpansionState,
): PluginExpansionOutcome {
  const results: PluginExpansionOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const activatedPluginIds: string[] = [];
  let turnExpansions = state.turnExpansions;
  let sessionExpansions = state.sessionExpansions;

  for (const tu of toolUses) {
    if (tu.name !== REQUEST_PLUGIN_TOOL) {
      remaining.push(tu);
      continue;
    }
    const pluginId = (tu.input as { pluginId?: unknown })?.pluginId;
    const availableIds = state.availablePluginIds;
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: `request_plugin 오류: pluginId (string) 필수. Available: ${availableIds.join(", ") || "(none)"}`,
        is_error: true,
      });
    } else if (!availableIds.includes(pluginId)) {
      results.push({
        tool_use_id: tu.id,
        content: `알 수 없는 플러그인 ID '${pluginId}'. 사용 가능: ${availableIds.join(", ") || "(없음)"}`,
        is_error: true,
      });
    } else if (turnExpansions >= MAX_PLUGIN_EXPANSION) {
      results.push({
        tool_use_id: tu.id,
        content: `request_plugin 한도 초과 (턴당 최대 ${MAX_PLUGIN_EXPANSION}회). '${pluginId}' 활성화 거부.`,
        is_error: true,
      });
    } else if (sessionExpansions >= MAX_SESSION_PLUGIN_EXPANSION) {
      log.warn(
        `request_plugin session cap reached (${MAX_SESSION_PLUGIN_EXPANSION}). ` +
        `Rejecting '${pluginId}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: `request_plugin 세션 한도 초과 (세션당 최대 ${MAX_SESSION_PLUGIN_EXPANSION}회). '${pluginId}' 활성화 거부.`,
        is_error: true,
      });
    } else {
      state.activePluginIds.add(pluginId);
      turnExpansions += 1;
      sessionExpansions += 1;
      activatedPluginIds.push(pluginId);
      results.push({
        tool_use_id: tu.id,
        // 실제 추가된 도구 수는 호출자가 rebuild 후 보강 가능하지만
        // 초기 메시지는 activation 사실만 보고한다 — 호출자가 replace 하기도 한다.
        content: `플러그인 '${pluginId}' 활성화됨.`,
        is_error: false,
      });
    }
  }

  return {
    results,
    remaining,
    activatedPluginIds,
    nextTurnExpansions: turnExpansions,
    nextSessionExpansions: sessionExpansions,
  };
}
