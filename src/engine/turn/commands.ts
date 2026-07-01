/**
 * Slash-command handlers (C9 Wave 3).
 *
 * `handleCommand` (built-in slash dispatch) and `handlePermissionCommand`
 * (`/permission ...` sub-dispatch). Extracted from `conversation-loop.ts` as
 * free functions over a `self: ConversationLoop` this-shaped param; the class
 * keeps a `handleCommand` delegator that runTurn's command route calls.
 */
import type { ConversationLoop } from "../conversation-loop.js";
import type { TurnCallbacks, TurnResult } from "./types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import type { ToolSource } from "../../tools/types.js";
import { t } from "../../i18n/index.js";

function toolProvenanceLabel(tool: {
  source: ToolSource;
  pluginId?: string;
  mcpServerId?: string;
}): string {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  return "builtin";
}

export async function handleCommand(
  self: ConversationLoop,
    command: string,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    if (!isUserKeyboardOrigin(inputOrigin)) {
      const result = t("be_conversationLoop.nonKeyboardSlashCommandBlocked");
      callbacks?.onTextDelta?.(result);
      callbacks?.onTurnComplete?.(result);
      return { text: result, toolCalls: [], route: "command" };
    }
    let result: string;

    switch (command) {
      case "new":
        self.newConversation();
        result = t("be_conversationLoop.cmdNewConversation");
        break;
      case "remember": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdRememberUsage"); break; }
        const title = args.slice(0, 40).replace(/\n/g, " ");
        await self.deps.memoryManager.saveMemory(title, args);
        result = t("be_conversationLoop.cmdRememberSaved", { title });
        break;
      }
      case "memory": {
        const memories = self.deps.memoryManager.listMemoryEntries();
        result = memories.length === 0
          ? t("be_conversationLoop.cmdMemoryEmpty")
          : memories.map((n) => `- ${n.title} (${n.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = self.listSessions(10);
        if (sessions.length === 0) { result = t("be_conversationLoop.cmdSessionsEmpty"); break; }
        const current = self.sessionId;
        const sessionListLines = sessions.slice(0, 10).map((s) => {
          const marker = s.id === current ? t("be_conversationLoop.cmdSessionMarkerCurrent") : "";
          const date = s.modifiedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
          return `- ${s.id.slice(0, 8)}… (${date})${marker}`;
        }).join("\n");
        result = t("be_conversationLoop.cmdSessionsList", { max: 10, list: sessionListLines });
        break;
      }
      case "load": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdLoadUsage"); break; }
        const targetId = args.trim();
        // 부분 ID 매칭
        const sessions = self.listSessions();
        const match = sessions.find((s) => s.id.startsWith(targetId));
        if (!match) { result = t("be_conversationLoop.cmdLoadNotFound", { id: targetId }); break; }
        const loaded = self.loadSession(match.id);
        result = loaded
          ? t("be_conversationLoop.cmdLoadSuccess", { id: match.id.slice(0, 8), count: self.history.length })
          : t("be_conversationLoop.cmdLoadFailed", { id: match.id });
        break;
      }
      case "vendor":
        result = t("be_conversationLoop.cmdVendorInfo", { vendor: self.getVendor(), session: self.sessionId.slice(0, 8), input: self.cumulativeUsage.inputTokens, output: self.cumulativeUsage.outputTokens });
        break;
      case "compact": {
        // manualCompact uses the LLM compact path (12-section structured summary +
        // freezeBoundary + summaryPreamble persistence + checkpoint append).
        // callbacks 전달 — onCompactOccurred 가 renderer 에 compact_notice 이벤트 전달 가능.
        const r = await self.manualCompact(callbacks);
        result = r.summary;
        break;
      }
      case "tools": {
        const tools = self.deps.toolRegistry.getVisibleTools();
        result = tools.map((tool) => `${tool.name} [${toolProvenanceLabel(tool)}]`).join("\n") || t("be_conversationLoop.cmdToolsEmpty");
        break;
      }
      case "permission": {
        result = await handlePermissionCommand(self, args, inputOrigin, callbacks);
        break;
      }
      case "help":
        result = t("be_conversationLoop.cmdHelp");
        break;
      default:
        result = t("be_conversationLoop.cmdUnknown", { command });
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }

export async function handlePermissionCommand(
  self: ConversationLoop,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<string> {
    const {
      dispatchPermissionAuditCommand,
      dispatchPermissionDirCommand,
      dispatchPermissionHooksCommand,
      dispatchPermissionReviewerCommandWithRewire,
      dispatchPermissionSlash,
    } = await import("../../permissions/permission-slash.js");
    const raw = args.trim().length > 0 ? `/permission ${args.trim()}` : "/permission";
    const outcome = dispatchPermissionSlash(
      raw,
      inputOrigin,
    );
    if (outcome.kind === "parse-error") return t("be_conversationLoop.permissionParseError", { error: outcome.error });
    if (outcome.kind === "show-current") {
      const mode = self.deps.permissionManager?.getMode() ?? "default";
      return t("be_conversationLoop.permissionShowCurrent", { mode });
    }
    if (outcome.kind === "dir") {
      const result = await dispatchPermissionDirCommand(outcome.cmd);
      if (!result.ok) {
        const warnings = result.warnings?.length ? t("be_conversationLoop.permissionDirWarnings", { warnings: result.warnings.map((w) => `- ${w}`).join("\n") }) : "";
        const ack = result.requiresAcknowledgement ? t("be_conversationLoop.permissionDirAckRequired") : "";
        return t("be_conversationLoop.permissionDirError", { error: result.error, warnings, ack });
      }
      if (result.verb === "list") {
        return [
          t("be_conversationLoop.permissionDirListHeader"),
          result.defaults.length ? t("be_conversationLoop.permissionDirListDefaults", { list: result.defaults.join(", ") }) : t("be_conversationLoop.permissionDirListDefaultsEmpty"),
          result.userAdditions.length ? t("be_conversationLoop.permissionDirListAdditions", { list: result.userAdditions.join(", ") }) : t("be_conversationLoop.permissionDirListAdditionsEmpty"),
          result.effective.length ? t("be_conversationLoop.permissionDirListEffective", { list: result.effective.join(", ") }) : t("be_conversationLoop.permissionDirListEffectiveEmpty"),
        ].join("\n");
      }
      if (result.verb === "allow") {
        if (result.sessionOnly && result.sessionDirectory) {
          self.addSessionAdditionalDirectory(result.sessionDirectory);
          return t("be_conversationLoop.permissionDirSessionAllowed", { dir: result.sessionDirectory });
        }
        return t("be_conversationLoop.permissionDirAllowed", { list: result.persisted.map((d) => `- ${d}`).join("\n") });
      }
      return t("be_conversationLoop.permissionDirDenied", { list: result.persisted.length ? result.persisted.map((d) => `- ${d}`).join("\n") : t("be_conversationLoop.permissionDirDeniedEmpty") });
    }
    if (outcome.kind === "reviewer") {
      const result = await dispatchPermissionReviewerCommandWithRewire(
        outcome.cmd,
        self.deps.rewireReviewerAgent,
      );
      if (!result.ok) return t("be_conversationLoop.permissionReviewerError", { error: result.error });
      const { mode, fallbackOnError, interactive } = result.settings;
      return [
        t("be_conversationLoop.permissionReviewerSettings"),
        `mode=${mode}`,
        "provider/model=active LLM settings",
        `fallbackOnError=${fallbackOnError}`,
        `interactiveAutoApprove=${interactive.autoApprove}`,
      ].join("\n");
    }
    if (outcome.kind === "audit") {
      const auditLogger = self.deps.auditLogger;
      if (!auditLogger) return t("be_conversationLoop.permissionAuditNoLogger");
      const result = dispatchPermissionAuditCommand(outcome.cmd, {
        auditDir: auditLogger.getAuditDir(),
        secret: auditLogger.getPermissionAuditSecret(),
        sealStore: auditLogger.getPermissionAuditSealStore() ?? undefined,
      });
      if (!result.ok) return t("be_conversationLoop.permissionAuditError", { error: result.error });
      if (result.verb === "verify") {
        return [
          `Audit verify: ${result.intact ? "intact" : "broken"}`,
          `files=${result.totalFiles}`,
          `entries=${result.totalEntries}`,
          ...(result.firstBrokenFile ? [`firstBrokenFile=${result.firstBrokenFile}`] : []),
        ].join("\n");
      }
      return [
        t("be_conversationLoop.permissionAuditRecent", { count: result.entries.length }),
        ...result.entries.map((entry) => JSON.stringify(entry)),
      ].join("\n");
    }
    if (outcome.kind === "mode") {
      const pm = self.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionModeNoManager");
      const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
      const result = await applyPermissionModeCommand(outcome.cmd, {
        permissionManager: pm,
        approvalGate: self.deps.approvalGate,
        auditLogger: self.deps.auditLogger,
        approvalBypass: {
          source: "builtin-slash",
          trustOrigin: "user-keyboard",
          explicitUserAction: true,
        },
      });
      if (!result.ok) return t("be_conversationLoop.permissionModeCancelled", { message: result.message ?? result.error });
      callbacks?.onPermissionModeChanged?.(result.mode);
      return t("be_conversationLoop.permissionModeChanged", {
        previous: result.previous,
        mode: result.mode,
        durability: result.durable ? t("be_conversationLoop.permissionModeDurable") : t("be_conversationLoop.permissionModeSession"),
      });
    }
    if (outcome.kind === "rules") {
      const pm = self.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionRulesNoManager");
      if (outcome.cmd.sub === "add") {
        if (outcome.cmd.action === "allow") {
          await pm.addAlwaysAllowedPersist(outcome.cmd.pattern);
        } else {
          await pm.addAlwaysDeniedPersist(outcome.cmd.pattern);
        }
        self.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleAdded", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      if (outcome.cmd.sub === "remove") {
        await pm.removeRule(outcome.cmd.pattern, outcome.cmd.action);
        self.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleRemoved", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      const rules = await pm.listPersistedRules();
      return rules.length
        ? rules.map((rule) => `- ${rule.action} ${rule.pattern}${rule.source ? ` [${rule.source}]` : ""}`).join("\n")
        : t("be_conversationLoop.permissionRulesEmpty");
    }
    if (outcome.kind !== "hooks") {
      return t("be_conversationLoop.permissionUnhandled", { kind: outcome.kind });
    }

    const result = await dispatchPermissionHooksCommand(outcome.cmd, {
      ...self.deps.hookTrustCommandOptions,
      manager: self.deps.scriptHookManager,
    });
    if (!result.ok) return t("be_conversationLoop.hookTrustError", { error: result.error });
    if (result.verb === "list") {
      const active = result.active.length === 0
        ? t("be_conversationLoop.hookListActiveEmpty")
        : result.active.map((h) => `- active ${h.fileName} [${h.state}]`).join("\n");
      const disabled = result.disabled.length === 0
        ? t("be_conversationLoop.hookListDisabledEmpty")
        : result.disabled.map((h) => `- disabled ${h.fileName}`).join("\n");
      return t("be_conversationLoop.hookTrustStatus", { active, disabled });
    }
    // accept|disable|reject mutated hook trust state. Mirror the IPC hook-trust
    // handlers (ipc/domains/permissions.ts) and notify multi-window
    // PermissionsTab subscribers so the quarantine banner live-refreshes
    // instead of waiting for tab re-entry. `list` is a no-op read above and
    // does not broadcast; failed commands already returned earlier.
    self.deps.broadcastPermissionConfigChanged?.();
    if (result.verb === "accept") {
      return t("be_conversationLoop.hookAccepted", { fileName: result.accepted.fileName, count: result.trusted.length });
    }
    if (result.verb === "disable") {
      return t("be_conversationLoop.hookDisabled", { fileName: result.disabled.fileName, count: result.trusted.length });
    }
    return t("be_conversationLoop.hookRejected", { fileName: result.rejected.fileName, count: result.trusted.length });
  }
