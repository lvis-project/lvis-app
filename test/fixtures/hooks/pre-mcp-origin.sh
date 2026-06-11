#!/bin/sh
# #811 hooks-on-mcp-calls fixture: deny a tool call originating from a SPECIFIC
# MCP server, proving the per-request MCP identity reaches the hook (env path).
cat > /dev/null
if [ "$LVIS_HOOK_MCP_SERVER_ID" = "blocked-srv" ]; then
  echo '{"action":"deny","reason":"blocked MCP server '"$LVIS_HOOK_MCP_SERVER_ID"'"}'
else
  echo '{"action":"allow","reason":"origin ok"}'
fi
