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

When run with no --date, this backfills every missing day between the day
after the manifest's latest published date and today (inclusive), not just
"today" — a scheduled GitHub Actions run that gets delayed past midnight UTC
would otherwise generate for the wrong (later) day and silently skip the
day it was actually meant to cover, forever. See backfill_dates().

Designed to be run by the GitHub Actions workflow every day (including
weekends), but can be run locally/manually too:

    python3 tools/generate_game.py                # today (+ backfill any gap)
    python3 tools/generate_game.py --force         # overwrite existing game(s)
    python3 tools/generate_game.py --date 2026-09-21 --force   # one specific day
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


def broad_area(name):
    area = name.rsplit(",", 1)[-1].strip()
    area = area.removeprefix("Glebygd ").removesuffix(" tätortsområde").removesuffix(" kommun")
    return area


def pick_round_order(unused, count, date_str):
    """Pick `count` locations from `unused` and order them easy -> hard.

    The first round is the most central/closest-to-downtown candidate
    (presumably the most recognizable, easing players in). The last round
    is the most distant/unusual candidate available (the "hard" round). The
    middle rounds are a random sample of whatever's left, in random order.
    """
    by_distance = sorted(
        unused, key=lambda loc: haversine_m(*CITY_CENTER, loc["lat"], loc["lng"])
    )

    # Vary the challenge profile by date while keeping it reproducible for
    # retries/backfills: most days get one hard round, some get two.
    rng = random.Random(f"{date_str}:hard-round-count")
    hard_count = rng.randint(1, 2)
    hardest = by_distance[-hard_count:]
    easiest = by_distance[0]

    remaining_pool = [loc for loc in by_distance if loc is not easiest and loc not in hardest]
    middle = rng.sample(remaining_pool, count - 1 - hard_count)

    ordered = [easiest] + middle + hardest
    for index, location in enumerate(ordered):
        location["_difficulty"] = "hard" if index >= len(ordered) - hard_count else "standard"
    return ordered


def dates_to_backfill(today, manifest_dates):
    """Every date that should have a published game by `today`, but doesn't
    yet, according to the manifest. Starts the day after the manifest's
    latest entry (so a fresh/empty manifest only ever targets `today` itself
    — there's no history to infer a start date from) and walks forward
    through `today` inclusive. This is what lets a delayed cron run silently
    "catch up" instead of permanently skipping the day it was meant for.
    """
    if manifest_dates:
        last = datetime.date.fromisoformat(sorted(manifest_dates)[-1])
        start = last + datetime.timedelta(days=1)
    else:
        start = today
    if start > today:
        return []
    dates = []
    cursor = start
    while cursor <= today:
        dates.append(cursor)
        cursor += datetime.timedelta(days=1)
    return dates


def generate_for_date(today, pool, key, force):
    """Generates and writes the game file for a single date, mutating `pool`
    in place (marking chosen locations used) and updating data/manifest.json
    on success. Returns True if a game was written, False if skipped/failed.
    """
    date_str = today.isoformat()
    game_file = GAMES_DIR / f"{date_str}.enc.json"
    if game_file.exists() and not force:
        print(f"Game for {date_str} already exists at {game_file}, skipping.")
        return False

    unused = [loc for loc in pool if not loc.get("used") and loc.get("verified") is True]

    reused = False
    if len(unused) < ROUND_COUNT:
        # Not enough fresh locations (fetch-locations.yml hasn't run yet this
        # week, or it failed) — fall back to reusing already-used verified
        # locations rather than failing outright. Bias towards the ones used
        # longest ago (oldest usedInGame date) so repeats stay spread out,
        # but — like pick_round_order()'s hard-round-count — pick which ones
        # with a date-seeded RNG rather than always taking the strict oldest
        # N. Otherwise reuse becomes a perfectly fixed rotation (same pool
        # exhausted -> same locations picked in the same order every single
        # cycle), which feels suspiciously non-random to repeat players even
        # though it's technically "spread out".
        already_used = [loc for loc in pool if loc.get("used") and loc.get("verified") is True]
        already_used.sort(key=lambda loc: loc.get("usedInGame") or "")
        needed = ROUND_COUNT - len(unused)
        if len(already_used) < needed:
            print(
                f"Not enough verified locations at all ({len(unused)} unused + "
                f"{len(already_used)} reusable) to generate {date_str}, even allowing "
                f"reuse. Add more with tools/add_location.py --verified or "
                f"tools/fetch_kartaview_locations.py."
            )
            return False
        print(
            f"Only {len(unused)} unused verified location(s) available for {date_str} — "
            f"reusing {needed} previously-used location(s) to fill it out."
        )
        rng = random.Random(f"{date_str}:reuse-pick")
        # Widen the candidate window beyond the bare minimum (oldest-used
        # half, or just `needed` if the pool is tiny) so there's actually
        # something to shuffle, then randomly sample from it.
        window = max(needed, len(already_used) // 2)
        reused_locations = rng.sample(already_used[:window], needed)
        candidates = unused + reused_locations
        reused = True
    else:
        candidates = unused

    missing_images = [loc["id"] for loc in candidates if not loc.get("imgData")]
    if missing_images:
        print(
            f"{len(missing_images)} verified location(s) are missing self-hosted image "
            f"data (imgData): {missing_images}. Run tools/backfill_images.py first."
        )
        return False

    chosen = pick_round_order(candidates, ROUND_COUNT, date_str)
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
                "area": broad_area(loc["name"]),
                "difficulty": loc["_difficulty"],
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

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"dates": []}
    if date_str not in manifest["dates"]:
        manifest["dates"].append(date_str)
        manifest["dates"].sort()
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"Generated game for {date_str} using locations: {[l['name'] for l in chosen]}")
    if reused:
        print(f"Note: {date_str}'s game reused some previously-used locations (pool was running low).")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="ISO date to generate for (default: today, plus backfill of any missing gap)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing game for that date")
    args = parser.parse_args()

    if not POOL_ENCRYPTED.exists():
        print(f"Missing {POOL_ENCRYPTED}. Run tools/build_pool.py first.")
        sys.exit(1)

    key = load_key_b64()
    envelope = json.loads(POOL_ENCRYPTED.read_text())
    pool = decrypt_json(envelope, key)

    if args.date:
        targets = [datetime.date.fromisoformat(args.date)]
    else:
        today = datetime.date.today()
        manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"dates": []}
        targets = dates_to_backfill(today, manifest.get("dates", [])) or [today]
        if len(targets) > 1:
            print(f"Backfilling {len(targets)} missing day(s): {[d.isoformat() for d in targets]}")

    any_generated = False
    for date in targets:
        generated = generate_for_date(date, pool, key, args.force)
        any_generated = any_generated or generated
        if generated:
            # Persist pool changes after every successful date so a later
            # failure (e.g. pool exhaustion mid-backfill) doesn't lose the
            # days that did succeed.
            pool_envelope = encrypt_json(pool, key)
            POOL_ENCRYPTED.write_text(json.dumps(pool_envelope, indent=2) + "\n")

    remaining_unused = len([loc for loc in pool if not loc.get("used") and loc.get("verified") is True])
    print(f"Remaining unused locations in pool: {remaining_unused}")

    if not any_generated and len(targets) == 1 and not (GAMES_DIR / f"{targets[0].isoformat()}.enc.json").exists():
        # Only the single-date (non-backfill) path should fail the process —
        # a backfill run that generates nothing new because everything
        # already existed is a normal no-op, not an error.
        sys.exit(1)


if __name__ == "__main__":
    main()

