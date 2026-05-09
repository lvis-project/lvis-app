#!/bin/sh
# Q12 P4 fixture: deny when trustOrigin is not user-keyboard.
# Reads stdin to verify the wire shape includes trustOrigin (we use the env var
# LVIS_HOOK_TRUST_ORIGIN as a quick check — exposed by the runner).
if [ "$LVIS_HOOK_TRUST_ORIGIN" != "user-keyboard" ]; then
  echo '{"action":"deny","reason":"non-user origin"}'
else
  echo '{"action":"allow","reason":"user-keyboard ok"}'
fi
