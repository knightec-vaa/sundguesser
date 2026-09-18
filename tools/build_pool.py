#!/usr/bin/env python3
"""Encrypt the local plaintext location pool (secrets/locations.json) into
data/pool.enc.json, which is safe to commit to the public repo.

Usage:
    python3 tools/build_pool.py
"""
import json
import sys
from pathlib import Path

from crypto_lib import REPO_ROOT, SECRETS_DIR, load_key_b64, encrypt_json

POOL_PLAINTEXT = SECRETS_DIR / "locations.json"
POOL_ENCRYPTED = REPO_ROOT / "data" / "pool.enc.json"


def main():
    if not POOL_PLAINTEXT.exists():
        print(f"Missing {POOL_PLAINTEXT}. Create it first (see tools/add_location.py).")
        sys.exit(1)

    pool = json.loads(POOL_PLAINTEXT.read_text())
    if not isinstance(pool, list):
        print("secrets/locations.json must contain a JSON array of locations.")
        sys.exit(1)

    ids = [loc.get("id") for loc in pool]
    if len(ids) != len(set(ids)):
        print("Duplicate location ids found in secrets/locations.json.")
        sys.exit(1)

    key = load_key_b64()
    envelope = encrypt_json(pool, key)
    POOL_ENCRYPTED.parent.mkdir(exist_ok=True)
    POOL_ENCRYPTED.write_text(json.dumps(envelope, indent=2) + "\n")
    print(f"Encrypted {len(pool)} locations -> {POOL_ENCRYPTED}")


if __name__ == "__main__":
    main()
