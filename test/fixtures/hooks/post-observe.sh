#!/bin/sh
# Permission policy P4 fixture: PostToolUse observe-only hook.
read -r _payload < /dev/stdin
echo '{"action":"allow","reason":"post observed"}'
