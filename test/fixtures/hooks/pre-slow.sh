#!/bin/sh
# Q12 P4 fixture: hook that sleeps past the timeout — caller treats as deny.
sleep 30
echo '{"action":"allow","reason":"never reached"}'
