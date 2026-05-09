#!/bin/sh
# Q12 P4 fixture: drains the wire-shape stdin and emits a fixed allow JSON.
# Used to verify the JSON payload reaches the hook (write-side) and the verdict
# parses correctly (read-side).
cat > /dev/null
echo '{"action":"allow","reason":"roundtrip"}'
