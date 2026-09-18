#!/usr/bin/env python3
"""Local development helper: mirrors what the deploy workflow does — decrypts
published games into a scratch build directory (.devdist/, gitignored) using
your local secrets/key.txt, then serves that directory. No key or plaintext
location data is ever written into the tracked repo files.

Usage:
    python3 tools/dev_server.py [port]
"""
import shutil
import socketserver
import sys
import http.server
from pathlib import Path

from crypto_lib import REPO_ROOT
from decrypt_for_deploy import decrypt_all_games

DEVDIST = REPO_ROOT / ".devdist"
SITE_FILES = ["index.html", "style.css", "script.js", "effects.js", "favicon.svg"]


def build_devdist():
    if DEVDIST.exists():
        shutil.rmtree(DEVDIST)
    DEVDIST.mkdir(parents=True)
    for f in SITE_FILES:
        shutil.copy(REPO_ROOT / f, DEVDIST / f)
    decrypt_all_games(DEVDIST)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    build_devdist()

    import os
    os.chdir(DEVDIST)

    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", port), handler) as httpd:
        print(f"Serving SundGuesser (dev build) at http://localhost:{port} (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
