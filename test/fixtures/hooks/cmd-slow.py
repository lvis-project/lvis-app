#!/usr/bin/env python3
# #811 command-hooks fixture: sleeps past the timeout so the runner fails closed.
import sys
import time

sys.stdin.read()
time.sleep(30)
print('{"action":"allow","reason":"should never be read"}')
