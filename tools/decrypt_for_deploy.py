#!/usr/bin/env python3
"""Decrypt all published games (per data/manifest.json) into plaintext JSON
files inside an output directory. This is run ONLY inside CI (or local dev),
using a key that's never exposed to the browser — the decrypted output is
written to the deploy artifact / a local scratch dir, and is never committed
to git.

Each game's photos are stored as embedded base64 (imgData/imgExt) inside the
encrypted game file (see tools/generate_game.py) so they're never exposed in
plaintext for unpublished/future games. Here, for already-published games
only, we decode them into actual image files under data/images/ and rewrite
each location's "img" to point at that file — so the deployed site serves
plain, cacheable image files (self-hosted, not hotlinked from a third-party
host) instead of bloating the game JSON with inline base64.

Usage:
    python3 tools/decrypt_for_deploy.py <output_dir>
"""
import base64
import json
import sys
from pathlib import Path

from crypto_lib import REPO_ROOT, load_key_b64, decrypt_json

GAMES_DIR = REPO_ROOT / "data" / "games"
MANIFEST = REPO_ROOT / "data" / "manifest.json"


def decrypt_all_games(output_dir: Path):
    key = load_key_b64()
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"dates": []}

    games_out = output_dir / "data" / "games"
    games_out.mkdir(parents=True, exist_ok=True)
    images_out = output_dir / "data" / "images"
    images_out.mkdir(parents=True, exist_ok=True)

    for date in manifest["dates"]:
        enc_path = GAMES_DIR / f"{date}.enc.json"
        if not enc_path.exists():
            print(f"Warning: {enc_path} listed in manifest but missing, skipping.")
            continue
        envelope = json.loads(enc_path.read_text())
        game = decrypt_json(envelope, key)

        for i, loc in enumerate(game.get("locations", [])):
            img_data = loc.pop("imgData", None)
            img_ext = loc.pop("imgExt", "jpg")
            if img_data:
                img_bytes = base64.b64decode(img_data)
                img_name = f"{date}-{i}.{img_ext}"
                (images_out / img_name).write_bytes(img_bytes)
                loc["img"] = f"data/images/{img_name}"
            # else: legacy game predating self-hosted images — "img" (a
            # plain URL) is already present on the location as-is.

        (games_out / f"{date}.json").write_text(json.dumps(game))

    (output_dir / "data").mkdir(parents=True, exist_ok=True)
    (output_dir / "data" / "manifest.json").write_text(json.dumps(manifest))
    print(f"Decrypted {len(manifest['dates'])} game(s) into {games_out}")


if __name__ == "__main__":
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "dist"
    decrypt_all_games(out_dir)
