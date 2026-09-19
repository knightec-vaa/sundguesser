#!/usr/bin/env python3
"""Add a new location to the local plaintext master pool
(secrets/locations.json), then re-run tools/build_pool.py to update the
encrypted, committable copy.

Every location needs a `verified` flag — the daily game generator
(tools/generate_game.py) will only ever pick from verified locations, so a
typo'd or estimated coordinate can never end up in a live game. Pass
--verified to confirm you've personally checked the lat/lng against the
actual photo (e.g. by dropping a pin on the exact spot in Google Maps /
OpenStreetMap, or reading real GPS EXIF data). Locations added without
--verified are saved but won't be drawn until you edit the file (or rerun
this command with --verified) once you've confirmed them.

Usage:
    python3 tools/add_location.py \\
        --name "Alnö kyrka" \\
        --lat 62.4536 --lng 17.4271 \\
        --img "https://example.com/photo.jpg" \\
        --verified
"""
import argparse
import json
import re
import sys

from crypto_lib import SECRETS_DIR

POOL_PLAINTEXT = SECRETS_DIR / "locations.json"


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "location"


def load_pool():
    if POOL_PLAINTEXT.exists():
        return json.loads(POOL_PLAINTEXT.read_text())
    return []


def save_pool(pool):
    SECRETS_DIR.mkdir(exist_ok=True)
    POOL_PLAINTEXT.write_text(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--lat", required=True, type=float)
    parser.add_argument("--lng", required=True, type=float)
    parser.add_argument("--img", required=True)
    parser.add_argument(
        "--verified", action="store_true",
        help="confirm you've personally checked these coordinates are exact",
    )
    parser.add_argument("--source", default="manual", help="provenance tag, e.g. manual/kartaview")
    args = parser.parse_args()

    pool = load_pool()

    base_id = slugify(args.name)
    existing_ids = {loc["id"] for loc in pool}
    loc_id = base_id
    suffix = 2
    while loc_id in existing_ids:
        loc_id = f"{base_id}-{suffix}"
        suffix += 1

    pool.append({
        "id": loc_id,
        "name": args.name,
        "lat": args.lat,
        "lng": args.lng,
        "img": args.img,
        "used": False,
        "usedInGame": None,
        "source": args.source,
        "verified": args.verified,
    })
    save_pool(pool)
    print(f"Added '{args.name}' (id={loc_id}). Total pool size: {len(pool)}")
    if not args.verified:
        print(
            "NOTE: saved as UNVERIFIED — the daily generator will skip it until "
            "you confirm the coordinates and set verified=true (or re-run with --verified)."
        )
    print("Now run: python3 tools/build_pool.py")


if __name__ == "__main__":
    main()
