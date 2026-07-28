#!/bin/sh
# Start as root, hand the runtime-mounted paths to the non-root app user,
# then drop privileges and run the server as 'node'.
#
#   /run/guest-services : root-owned dir Docker Desktop provides at runtime;
#                         the extension UI reaches the backend via a socket here.
#   /app/data           : named volume, created root-owned on first use.
#
# Both must be writable by uid 1000 (node) or the socket bind and SQLite open
# fail. chown here fixes them regardless of the volume's prior ownership.
mkdir -p /run/guest-services /app/data 2>/dev/null || true
chown node:node /run/guest-services /app/data 2>/dev/null || true

exec gosu node node backend/server.js
