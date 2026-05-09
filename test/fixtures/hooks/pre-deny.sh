#!/bin/sh
# Permission policy P4 fixture: PreToolUse hook that denies regardless of input.
read -r _payload < /dev/stdin
echo '{"action":"deny","reason":"fixture deny"}'
