#!/usr/bin/env python3
# #811 command-hooks fixture: emits non-{action,reason} output so the runner
# fails closed (bad-output → deny).
import sys

sys.stdin.read()
print("this is not the json you are looking for")
