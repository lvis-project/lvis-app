#!/usr/bin/env python3
# #811 command-hooks fixture: a Python command hook.
# Reads the wire-shape JSON on stdin and emits {action,reason}. Denies when the
# tool name contains "blocked"; otherwise allows. Proves a generic `command`
# handler (python3 <local script>) runs through the SAME stdin/stdout contract.
import json
import sys

raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except Exception:
    print(json.dumps({"action": "deny", "reason": "bad stdin"}))
    sys.exit(0)

tool = payload.get("toolName", "")
if "blocked" in tool:
    print(json.dumps({"action": "deny", "reason": "python policy denied " + tool}))
else:
    print(json.dumps({"action": "allow", "reason": "python policy ok"}))
