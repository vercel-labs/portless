#!/bin/sh
# Starts the server in the background and exits before it is listening,
# like CLIs that self-daemonize.
node "$(dirname "$0")/server.mjs" > /dev/null 2>&1 &
exit 0
