import { isRecord } from "../shared/is-record.js";

export const CLAUDE_CODE_MCP_SERVER_NAME = "lvis-host-tools";
export const CLAUDE_CODE_MAX_PROMPT_BYTES = 512 * 1024;
export const CLAUDE_CODE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The CLI's tool list covers built-ins; MCP approval is a separate option. */
export function claudeCodePrintArgs(mcpConfigPath: string, toolNames: readonly string[]): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--permission-mode", "default",
    "--strict-mcp-config", "--mcp-config", mcpConfigPath,
    "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
    ...(toolNames.length ? ["--allowedTools", toolNames.join(",")] : []),
  ];
}

function invalid(): never {
  throw new Error("claude-code-operation-failed");
}

/**
 * Validates the print stream for verification and chat. Tool announcements
 * never authorize a host call. LVIS supplies complete history on every round,
 * so native session ids are checked but never resumed.
 */
export class ClaudeCodeStream {
  private sessionId: string | null = null;
  private result = false;
  private announcedHostTool = false;
  private hostToolAccepted = false;
  private hasText = false;
  stopReason: "end_turn" | "max_tokens" = "end_turn";
  private readonly allowedTools: ReadonlySet<string>;

  constructor(toolNames: readonly string[]) {
    this.allowedTools = new Set(toolNames);
  }

  get initialized(): boolean { return this.sessionId !== null; }

  acceptHostCall(): void {
    if (!this.initialized || this.result || this.hostToolAccepted) invalid();
    this.hostToolAccepted = true;
  }

  accept(event: unknown): string[] {
    if (!isRecord(event) || typeof event.type !== "string" || this.result) invalid();
    if (event.type === "system" && event.subtype === "init") {
      if (this.initialized
        || typeof event.session_id !== "string"
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(event.session_id)
        || !Array.isArray(event.tools)
        || event.tools.some((tool) => typeof tool !== "string" || !this.isAllowedTool(tool))
        || !Array.isArray(event.mcp_servers)
        || event.mcp_servers.some((server) => !isRecord(server)
          || server.name !== CLAUDE_CODE_MCP_SERVER_NAME || server.status !== "connected")
        || event.mcp_servers.length !== (this.allowedTools.size ? 1 : 0)
        || (event.plugins !== undefined && (!Array.isArray(event.plugins) || event.plugins.length > 0))) invalid();
      const exposed = event.tools;
      if ([...this.allowedTools].some((tool) => !exposed.includes(tool))) invalid();
      this.sessionId = event.session_id;
      return [];
    }
    if (!this.initialized || event.session_id !== this.sessionId) invalid();
    if (event.type === "assistant") {
      if (!isRecord(event.message) || !Array.isArray(event.message.content)
        || event.error !== undefined
        || (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null)) invalid();
      const text: string[] = [];
      for (const part of event.message.content) {
        if (!isRecord(part)) invalid();
        if (part.type === "text") {
          if (typeof part.text !== "string") invalid();
          if (part.text) this.hasText = true;
          text.push(part.text);
        } else if (part.type === "tool_use") {
          if (typeof part.name !== "string" || !this.isAllowedTool(part.name)
            || typeof part.id !== "string" || !part.id || !isRecord(part.input)) invalid();
          if (this.allowedTools.has(part.name)) this.announcedHostTool = true;
        } else if (part.type !== "thinking" && part.type !== "redacted_thinking") {
          invalid();
        }
      }
      return text;
    }
    if (event.type === "result") {
      if (event.subtype !== "success" || event.is_error !== false
        || typeof event.result !== "string" || (this.announcedHostTool && !this.hostToolAccepted)
        || (event.permission_denials !== undefined
          && (!Array.isArray(event.permission_denials) || event.permission_denials.length > 0))) invalid();
      this.result = true;
      if (event.stop_reason === "max_tokens") this.stopReason = "max_tokens";
      // The result also carries the actual answer. Project it when no
      // assistant text was reported, without duplicating preceding text.
      return !this.hasText && event.result ? [event.result] : [];
    }
    // Metadata carries no execution authority. Unexpected hooks, native tasks,
    // and unknown wire records are errors, not evidence of a successful turn.
    if (event.type === "system" && ["api_retry", "status"].includes(String(event.subtype))) return [];
    if (event.type === "rate_limit_event") return [];
    if (event.type === "user" && isRecord(event.message)
      && Array.isArray(event.message.content)
      && event.message.content.every((part) => isRecord(part) && part.type === "tool_result")) return [];
    invalid();
  }

  assertComplete(): void {
    if (!this.result) invalid();
  }

  private isAllowedTool(name: string): boolean {
    // This termination control cannot be removed while MCP tools remain.
    // It grants no filesystem or process capability.
    return this.allowedTools.has(name) || (this.allowedTools.size > 0 && name === "EndConversation");
  }
}
