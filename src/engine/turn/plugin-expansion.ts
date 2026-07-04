



import type { ToolUseBlock } from "../../tools/executor.js";
import { createLogger } from "../../lib/logger.js";
import { t } from "../../i18n/index.js";
const log = createLogger("lvis");

export const REQUEST_PLUGIN_TOOL = "request_plugin";

export const MAX_PLUGIN_EXPANSION = 2;

export const MAX_SESSION_PLUGIN_EXPANSION = 6;

export interface PluginExpansionState {

  turnExpansions: number;

  sessionExpansions: number;

  activePluginIds: Set<string>;

  availablePluginIds: string[];
  /**
   * Session-scoped on-demand activation sink. When a registry-DISABLED plugin
   * (per {@link isPluginEnabled}) is activated, its id is recorded here so the
   * caller's scope resolver skips the disabled-drop for THIS session only —
   * never persisting enabled state (setPluginEnabled is NOT called). A
   * disabled id can only reach the activation branch if it already passed the
   * caller's allow-list gate (it would not be in {@link availablePluginIds}
   * otherwise). Omitted for main chat.
   */
  sessionActivatedPluginIds?: Set<string>;
  /** Registry active-state predicate; `false` ⇒ the plugin is disabled. */
  isPluginEnabled?: (pluginId: string) => boolean;
}

export interface PluginExpansionOutcome {

  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  activatedPluginIds: string[];

  nextTurnExpansions: number;

  nextSessionExpansions: number;
}




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
        content: t("be_pluginExpansion.missingPluginId", { available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (!availableIds.includes(pluginId)) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.unknownPluginId", { pluginId, available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (turnExpansions >= MAX_PLUGIN_EXPANSION) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.turnLimitExceeded", { max: String(MAX_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else if (sessionExpansions >= MAX_SESSION_PLUGIN_EXPANSION) {
      log.warn(
        `request_plugin session cap reached (${MAX_SESSION_PLUGIN_EXPANSION}). ` +
        `Rejecting '${pluginId}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.sessionLimitExceeded", { max: String(MAX_SESSION_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else {
      state.activePluginIds.add(pluginId);
      // Session-scoped on-demand activation — a registry-disabled plugin that
      // cleared the caller's allow-list gate (else it would not be in
      // availablePluginIds) is activated for THIS session only. Record it so
      // the scope resolver keeps its tools WITHOUT persisting enabled=true.
      if (state.isPluginEnabled?.(pluginId) === false) {
        state.sessionActivatedPluginIds?.add(pluginId);
      }
      turnExpansions += 1;
      sessionExpansions += 1;
      activatedPluginIds.push(pluginId);
      results.push({
        tool_use_id: tu.id,
        // 실제 추가된 도구 수는 호출자가 rebuild 후 보강 가능하지만
        // 초기 메시지는 activation 사실만 보고한다 — 호출자가 replace 하기도 한다.
        content: t("be_pluginExpansion.activated", { pluginId }),
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
