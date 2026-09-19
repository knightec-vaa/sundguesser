#!/usr/bin/env python3
"""One-off (but safe to re-run) migration: downloads + compresses the photo
for any pool entry that doesn't yet have self-hosted image bytes
(imgData/imgExt), using its existing `img` URL. Needed once for locations
added before self-hosting existed; new locations get imgData immediately via
tools/add_location.py / tools/fetch_kartaview_locations.py.

Usage:
    python3 tools/backfill_images.py
    python3 tools/build_pool.py   # re-encrypt after backfilling
"""
import json

from crypto_lib import SECRETS_DIR
from image_utils import fetch_and_compress

POOL_PLAINTEXT = SECRETS_DIR / "locations.json"


def main():
    if not POOL_PLAINTEXT.exists():
        print(f"No {POOL_PLAINTEXT} found.")
        return

    pool = json.loads(POOL_PLAINTEXT.read_text())
    updated = 0
    for loc in pool:
        if loc.get("imgData"):
            continue
        img_url = loc.get("img")
        if not img_url:
            print(f"  ! {loc['id']}: no img URL to backfill from, skipping.")
            continue
        try:
            img_data, img_ext = fetch_and_compress(img_url)
        except Exception as exc:
            print(f"  ! {loc['id']}: failed to fetch/compress ({exc}), skipping.")
            continue
        loc["imgData"] = img_data
        loc["imgExt"] = img_ext
        updated += 1
        print(f"  + {loc['id']}: backfilled ({len(img_data)} base64 chars)")

    if updated:
        POOL_PLAINTEXT.write_text(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")
    print(f"\nBackfilled {updated} location(s). Run tools/build_pool.py to re-encrypt.")


if __name__ == "__main__":
    main()
