#!/bin/sh
# Q12 P4 fixture: PreToolUse hook that always allows.
# Reads JSON from stdin, ignores it, returns allow.
read -r _payload < /dev/stdin
echo '{"action":"allow","reason":"fixture allow"}'
