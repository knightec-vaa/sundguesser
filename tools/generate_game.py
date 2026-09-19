#!/usr/bin/env python3
"""Pick 5 never-before-used locations from the encrypted pool and publish
them as a new day's game (data/games/<date>.enc.json). Marks the chosen
locations as used in the pool so they never repeat.

Designed to be run by the GitHub Actions workflow every day (including
weekends), but can be run locally/manually too:

    python3 tools/generate_game.py                # today
    python3 tools/generate_game.py --force         # overwrite existing game
    python3 tools/generate_game.py --date 2026-09-21 --force   # backfill
"""
import argparse
import datetime
import json
import random
import sys
from pathlib import Path

from crypto_lib import REPO_ROOT, load_key_b64, encrypt_json, decrypt_json

POOL_ENCRYPTED = REPO_ROOT / "data" / "pool.enc.json"
GAMES_DIR = REPO_ROOT / "data" / "games"
MANIFEST = REPO_ROOT / "data" / "manifest.json"
ROUND_COUNT = 5


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="ISO date to generate for (default: today)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing game for that date")
    args = parser.parse_args()

    today = datetime.date.fromisoformat(args.date) if args.date else datetime.date.today()

    date_str = today.isoformat()
    game_file = GAMES_DIR / f"{date_str}.enc.json"
    if game_file.exists() and not args.force:
        print(f"Game for {date_str} already exists at {game_file}, skipping.")
        return

    if not POOL_ENCRYPTED.exists():
        print(f"Missing {POOL_ENCRYPTED}. Run tools/build_pool.py first.")
        sys.exit(1)

    key = load_key_b64()
    envelope = json.loads(POOL_ENCRYPTED.read_text())
    pool = decrypt_json(envelope, key)

    unused = [loc for loc in pool if not loc.get("used")]
    if len(unused) < ROUND_COUNT:
        print(
            f"Not enough unused locations left ({len(unused)} available, "
            f"{ROUND_COUNT} needed). Add more with tools/add_location.py."
        )
        sys.exit(1)

    chosen = random.sample(unused, ROUND_COUNT)
    chosen_ids = {loc["id"] for loc in chosen}

    game = {
        "date": date_str,
        "locations": [
            {"name": loc["name"], "lat": loc["lat"], "lng": loc["lng"], "img": loc["img"]}
            for loc in chosen
        ],
    }

    GAMES_DIR.mkdir(parents=True, exist_ok=True)
    game_envelope = encrypt_json(game, key)
    game_file.write_text(json.dumps(game_envelope, indent=2) + "\n")

    for loc in pool:
        if loc["id"] in chosen_ids:
            loc["used"] = True
            loc["usedInGame"] = date_str

    pool_envelope = encrypt_json(pool, key)
    POOL_ENCRYPTED.write_text(json.dumps(pool_envelope, indent=2) + "\n")

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"dates": []}
    if date_str not in manifest["dates"]:
        manifest["dates"].append(date_str)
        manifest["dates"].sort()
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"Generated game for {date_str} using locations: {[l['name'] for l in chosen]}")
    print(f"Remaining unused locations in pool: {len(unused) - ROUND_COUNT}")


if __name__ == "__main__":
    main()
