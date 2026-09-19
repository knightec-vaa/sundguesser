#!/usr/bin/env python3
"""One-off (but safe to re-run) migration: patches already-published game
files (data/games/*.enc.json) that still only carry an external `img` URL
(because they were generated before self-hosted images existed) with the
matching pool location's `imgData`/`imgExt`, so every published game serves
its photos from the fast, self-hosted data/images/ path instead of a slow
third-party host.

Matches each game location to its pool entry by (name, lat, lng) — game
entries don't carry a stable id, but those three fields are copied verbatim
from the pool at generation time, so an exact match reliably identifies the
right pool entry (which is expected to be marked used/usedInGame for that
date already).

Does NOT change which locations are in a game, its date, or the pool's
used/usedInGame bookkeeping — purely fills in missing imgData/imgExt on
existing entries.

Usage:
    python3 tools/backfill_game_images.py
"""
import json

from crypto_lib import REPO_ROOT, SECRETS_DIR, load_key_b64, encrypt_json, decrypt_json

GAMES_DIR = REPO_ROOT / "data" / "games"
POOL_PLAINTEXT = SECRETS_DIR / "locations.json"


def main():
    if not POOL_PLAINTEXT.exists():
        print(f"No {POOL_PLAINTEXT} found (need the plaintext pool to source imgData from).")
        return

    pool = json.loads(POOL_PLAINTEXT.read_text())
    # Index pool entries by (name, rounded lat, rounded lng) for exact match.
    pool_index = {(loc["name"], loc["lat"], loc["lng"]): loc for loc in pool}

    key = load_key_b64()
    game_files = sorted(GAMES_DIR.glob("*.enc.json"))
    if not game_files:
        print(f"No game files found in {GAMES_DIR}.")
        return

    total_patched = 0
    for game_file in game_files:
        envelope = json.loads(game_file.read_text())
        game = decrypt_json(envelope, key)
        changed = False
        for gloc in game.get("locations", []):
            if gloc.get("imgData"):
                continue
            match = pool_index.get((gloc["name"], gloc["lat"], gloc["lng"]))
            if not match or not match.get("imgData"):
                print(f"  ! {game_file.name}: no imgData available for '{gloc['name']}', skipping.")
                continue
            gloc["imgData"] = match["imgData"]
            gloc["imgExt"] = match["imgExt"]
            gloc.pop("img", None)
            changed = True
            total_patched += 1
            print(f"  + {game_file.name}: backfilled '{gloc['name']}'")

        if changed:
            new_envelope = encrypt_json(game, key)
            game_file.write_text(json.dumps(new_envelope, indent=2) + "\n")

    print(f"\nPatched {total_patched} location(s) across {len(game_files)} game file(s).")


if __name__ == "__main__":
    main()
