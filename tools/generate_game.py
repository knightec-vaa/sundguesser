#!/usr/bin/env python3
"""Pick 5 never-before-used, GPS-verified locations from the encrypted pool
and publish them as a new day's game (data/games/<date>.enc.json). Marks the
chosen locations as used in the pool so they never repeat.

Rounds are ordered easy -> hard: round 1 is the most central/recognizable
candidate available, round 5 is the most distant/unusual one (the client
shows a fire border on the last round). See pick_round_order().

Only locations with verified=true are eligible — this guards against an
estimated/typo'd coordinate ever reaching a live game. See
tools/add_location.py (--verified flag) and tools/fetch_kartaview_locations.py
(auto-verified via real GPS metadata) for how locations become verified.

Designed to be run by the GitHub Actions workflow every day (including
weekends), but can be run locally/manually too:

    python3 tools/generate_game.py                # today
    python3 tools/generate_game.py --force         # overwrite existing game
    python3 tools/generate_game.py --date 2026-09-21 --force   # backfill
"""
import argparse
import datetime
import json
import math
import random
import sys
from pathlib import Path

from crypto_lib import REPO_ROOT, load_key_b64, encrypt_json, decrypt_json

POOL_ENCRYPTED = REPO_ROOT / "data" / "pool.enc.json"
GAMES_DIR = REPO_ROOT / "data" / "games"
MANIFEST = REPO_ROOT / "data" / "manifest.json"
ROUND_COUNT = 5

# Stora Torget, the heart of Sundsvall city centre. Used only to rank
# candidate locations by "how central" they are, so a game's rounds can be
# ordered from easy (near the city core, presumably more recognizable) to
# hard (unusual/outlying) rather than pure random.
CITY_CENTER = (62.3908, 17.3069)


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def pick_round_order(unused, count):
    """Pick `count` locations from `unused` and order them easy -> hard.

    The first round is the most central/closest-to-downtown candidate
    (presumably the most recognizable, easing players in). The last round
    is the most distant/unusual candidate available (the "hard" round). The
    middle rounds are a random sample of whatever's left, in random order.
    """
    by_distance = sorted(
        unused, key=lambda loc: haversine_m(*CITY_CENTER, loc["lat"], loc["lng"])
    )

    easiest = by_distance[0]
    hardest = by_distance[-1]

    remaining_pool = [loc for loc in by_distance if loc is not easiest and loc is not hardest]
    middle = random.sample(remaining_pool, count - 2)

    return [easiest] + middle + [hardest]


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

    unused = [loc for loc in pool if not loc.get("used") and loc.get("verified") is True]

    reused = False
    if len(unused) < ROUND_COUNT:
        # Not enough fresh locations (fetch-locations.yml hasn't run yet this
        # week, or it failed) — fall back to reusing already-used verified
        # locations rather than failing outright. Prefer the ones that were
        # used longest ago (oldest usedInGame date) so repeats are as spread
        # out as possible, and top up with the unused ones we do have.
        already_used = [loc for loc in pool if loc.get("used") and loc.get("verified") is True]
        already_used.sort(key=lambda loc: loc.get("usedInGame") or "")
        needed = ROUND_COUNT - len(unused)
        if len(already_used) < needed:
            print(
                f"Not enough verified locations at all ({len(unused)} unused + "
                f"{len(already_used)} reusable), even allowing reuse. Add more with "
                f"tools/add_location.py --verified or tools/fetch_kartaview_locations.py."
            )
            sys.exit(1)
        print(
            f"Only {len(unused)} unused verified location(s) available — reusing "
            f"{needed} previously-used location(s) to fill out today's game."
        )
        candidates = unused + already_used[:needed]
        reused = True
    else:
        candidates = unused

    missing_images = [loc["id"] for loc in candidates if not loc.get("imgData")]
    if missing_images:
        print(
            f"{len(missing_images)} verified location(s) are missing self-hosted image "
            f"data (imgData): {missing_images}. Run tools/backfill_images.py first."
        )
        sys.exit(1)

    chosen = pick_round_order(candidates, ROUND_COUNT)
    chosen_ids = {loc["id"] for loc in chosen}

    game = {
        "date": date_str,
        "locations": [
            {
                "name": loc["name"],
                "lat": loc["lat"],
                "lng": loc["lng"],
                "imgData": loc["imgData"],
                "imgExt": loc["imgExt"],
            }
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
    if reused:
        print("Note: today's game reused some previously-used locations (pool was running low).")
    remaining_unused = len([loc for loc in pool if not loc.get("used") and loc.get("verified") is True])
    print(f"Remaining unused locations in pool: {remaining_unused}")


if __name__ == "__main__":
    main()
