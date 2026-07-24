#!/bin/bash
# Glass Teleprompter launcher — serves the app locally and opens it in Chrome.
# Speech recognition needs a localhost (secure) origin, so we serve over http
# rather than opening the file directly.
cd "$(dirname "$0")"
PORT=8400

( sleep 1
  open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null \
    || open "http://localhost:$PORT"
) &

echo "Glass Teleprompter → http://localhost:$PORT   (Ctrl-C to quit)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
