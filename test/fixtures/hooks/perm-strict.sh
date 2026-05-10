#!/bin/sh
# Permission policy P4 fixture: PermissionRequest hook that denies all approval rounds.
read -r _payload < /dev/stdin
echo '{"action":"deny","reason":"strict perm policy"}'
