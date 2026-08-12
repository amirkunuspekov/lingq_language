#!/bin/bash
# Double-click this file to launch the Reader app.
# It starts a local web server in this folder and opens the app in your browser.
# Closing this Terminal window (or pressing Ctrl+C) stops the server.

# Move to the folder this script lives in, so it works no matter where it's run from.
cd "$(dirname "$0")" || exit 1

PORT=8001
# If 8000 is taken, walk upward to find a free port.
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://localhost:$PORT"
echo "📖  Reader is starting at $URL"
echo "    (leave this window open while reading; press Ctrl+C or close it to stop)"
echo ""

# Open the browser shortly after the server comes up.
( sleep 1; open "$URL" ) &

# Run the server in the foreground so the window stays alive and Ctrl+C stops it.
exec python3 -m http.server "$PORT"
