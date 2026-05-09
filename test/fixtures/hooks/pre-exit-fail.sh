#!/bin/sh
# Q12 P4 fixture: hook that exits non-zero — caller treats as deny.
echo "boom" >&2
exit 7
