/**
 * Shared fixture for the MCP app panel suites (fullscreen, PiP, view): the
 * payload each renders and the webview query each asserts on. Three suites
 * carried both; nothing here touches a subject's mocks.
 */
import type { McpUiPayload } from "../../../../mcp/types.js";

export function mcpUiPayload(serverId: string): McpUiPayload {
  return { serverId, resourceUri: "ui://card/1" };
}

export function webviewNodes(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("webview");
}
