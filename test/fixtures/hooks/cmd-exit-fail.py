#!/usr/bin/env python3
# #811 command-hooks fixture: exits non-zero so the runner fails closed
# (nonzero-exit → deny) even though it printed an allow on stdout.
import sys

sys.stdin.read()
print('{"action":"allow","reason":"ignored because exit != 0"}')
sys.exit(3)
