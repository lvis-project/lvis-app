#!/usr/bin/env python3
# #811 command-hooks fixture: env-allowlist probe.
# Denies (with the offending names) if ANY secret-shaped env var leaked into the
# child. Proves the env allowlist holds for the generalized runner: only
# LVIS_HOOK_* + the generic FORWARD_ENV_KEYS are present.
import json
import os
import sys

sys.stdin.read()

forbidden = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "LVIS_SECRET_PROBE",
    "GOOGLE_API_KEY",
]
leaked = [name for name in forbidden if name in os.environ]
if leaked:
    print(json.dumps({"action": "deny", "reason": "leaked: " + ",".join(leaked)}))
else:
    print(json.dumps({"action": "allow", "reason": "no secret env"}))
