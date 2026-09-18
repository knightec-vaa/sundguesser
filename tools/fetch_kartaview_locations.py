#!/usr/bin/env python3
"""Auto-source new game locations from KartaView (kartaview.org), a free,
no-API-key street-level imagery service with real GPS-tagged photos.

Queries a grid of points across Sundsvall, picks well-spaced candidate
photos, reverse-geocodes a human-readable name via OpenStreetMap Nominatim,
and appends them to secrets/locations.json (the plaintext master pool).

This supplements (does not replace) manually curated locations.

Usage:
    python3 tools/fetch_kartaview_locations.py --count 30
    python3 tools/build_pool.py   # re-encrypt after reviewing additions
"""
import argparse
import json
import math
import time
import urllib.error
import urllib.request

from crypto_lib import SECRETS_DIR

POOL_PLAINTEXT = SECRETS_DIR / "locations.json"

KARTAVIEW_API = "https://api.openstreetcam.org/2.0/photo/"
NOMINATIM_API = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "SundGuesser/1.0 (lunch-time geoguesser prototype)"

# Grid of query points spread across central/greater Sundsvall.
GRID_POINTS = [
    (62.3908, 17.3069), (62.3925, 17.3055), (62.3880, 17.3100),
    (62.3950, 17.2950), (62.3860, 17.3150), (62.3800, 17.2800),
    (62.4000, 17.3200), (62.3890, 17.2900), (62.3960, 17.3100),
    (62.3830, 17.3050), (62.3915, 17.3150), (62.3870, 17.2950),
    (62.3940, 17.3000), (62.3820, 17.3200), (62.3990, 17.3050),
    (62.3970, 17.2900), (62.3780, 17.3000), (62.3900, 17.3250),
    (62.3850, 17.2850), (62.4020, 17.3100), (62.3760, 17.2900),
    (62.3930, 17.3200), (62.3810, 17.3120), (62.3980, 17.3300),
]

MIN_SPACING_METERS = 120  # avoid near-duplicate photos of the same spot


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def query_kartaview(lat, lng, radius=300):
    url = f"{KARTAVIEW_API}?lat={lat}&lng={lng}&radius={radius}"
    try:
        data = fetch_json(url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return []
    return data.get("result", {}).get("data") or []


def reverse_geocode(lat, lng):
    url = f"{NOMINATIM_API}?format=json&lat={lat}&lon={lng}&zoom=17&addressdetails=1"
    try:
        data = fetch_json(url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    addr = data.get("address", {})
    road = addr.get("road") or addr.get("pedestrian") or addr.get("neighbourhood")
    suburb = addr.get("suburb") or addr.get("city_district") or addr.get("city")
    if road and suburb and road != suburb:
        return f"{road}, {suburb}"
    return road or suburb or data.get("display_name", "").split(",")[0]


def image_url(photo):
    # LTh ("large thumb") variant is a decent 1280x720 JPEG, reliably hosted.
    return photo.get("fileurlLTh") or photo.get("fileurl", "").replace("{{sizeprefix}}", "lth")


SWEDISH_TRANSLIT = str.maketrans({"å": "a", "ä": "a", "ö": "o", "é": "e", "ü": "u"})


def slugify(name):
    import re
    ascii_name = name.lower().translate(SWEDISH_TRANSLIT)
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")
    return slug or "kartaview-spot"


def load_pool():
    if POOL_PLAINTEXT.exists():
        return json.loads(POOL_PLAINTEXT.read_text())
    return []


def save_pool(pool):
    SECRETS_DIR.mkdir(exist_ok=True)
    POOL_PLAINTEXT.write_text(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=30, help="how many new locations to add")
    parser.add_argument("--dry-run", action="store_true", help="print candidates, don't write")
    args = parser.parse_args()

    pool = load_pool()
    existing_coords = [(loc["lat"], loc["lng"]) for loc in pool]
    existing_ids = {loc["id"] for loc in pool}

    print(f"Querying KartaView across {len(GRID_POINTS)} grid points in Sundsvall...")
    candidates = []
    seen_ids = set()
    for lat, lng in GRID_POINTS:
        photos = query_kartaview(lat, lng)
        for p in photos:
            pid = p.get("id")
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            try:
                plat, plng = float(p["lat"]), float(p["lng"])
            except (KeyError, ValueError, TypeError):
                continue
            candidates.append({"id": pid, "lat": plat, "lng": plng, "photo": p})
        time.sleep(0.5)

    print(f"Found {len(candidates)} unique candidate photos.")

    # Greedily select well-spaced candidates.
    selected = []
    all_known = list(existing_coords)
    for c in candidates:
        if len(selected) >= args.count:
            break
        too_close = any(
            haversine_m(c["lat"], c["lng"], klat, klng) < MIN_SPACING_METERS
            for klat, klng in all_known
        )
        if too_close:
            continue
        selected.append(c)
        all_known.append((c["lat"], c["lng"]))

    print(f"Selected {len(selected)} well-spaced candidates (min {MIN_SPACING_METERS}m apart).")

    new_entries = []
    for c in selected:
        lat, lng, photo = c["lat"], c["lng"], c["photo"]
        img = image_url(photo)
        if not img:
            continue
        name = reverse_geocode(lat, lng) or "Sundsvall"
        time.sleep(1)  # Nominatim usage policy: max 1 req/sec

        base_id = f"kv-{slugify(name)}"
        loc_id = base_id
        suffix = 2
        while loc_id in existing_ids:
            loc_id = f"{base_id}-{suffix}"
            suffix += 1
        existing_ids.add(loc_id)

        entry = {
            "id": loc_id,
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "img": img,
            "used": False,
            "usedInGame": None,
            "source": "kartaview",
        }
        new_entries.append(entry)
        print(f"  + {loc_id}: {name} ({lat:.5f},{lng:.5f})\n    {img}")

    if args.dry_run:
        print(f"\nDry run: {len(new_entries)} candidates prepared, nothing written.")
        return

    pool.extend(new_entries)
    save_pool(pool)
    print(f"\nAdded {len(new_entries)} new locations. Pool size now {len(pool)}.")
    print("Run: python3 tools/build_pool.py  to re-encrypt.")


if __name__ == "__main__":
    main()
