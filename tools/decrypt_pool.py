#!/usr/bin/env python3
"""Decrypt data/pool.enc.json into the local plaintext secrets/locations.json.

Used by CI/tooling that needs to read or append to the master location pool
without a human having a persistent plaintext copy around already (e.g. the
fetch-locations workflow, which runs entirely inside a throwaway CI runner).

Usage:
    python3 tools/decrypt_pool.py
"""
import json

from crypto_lib import REPO_ROOT, SECRETS_DIR, load_key_b64, decrypt_json

POOL_ENCRYPTED = REPO_ROOT / "data" / "pool.enc.json"
POOL_PLAINTEXT = SECRETS_DIR / "locations.json"


def main():
    key = load_key_b64()
    envelope = json.loads(POOL_ENCRYPTED.read_text())
    pool = decrypt_json(envelope, key)
    SECRETS_DIR.mkdir(exist_ok=True)
    POOL_PLAINTEXT.write_text(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")
    print(f"Decrypted {len(pool)} locations -> {POOL_PLAINTEXT}")


if __name__ == "__main__":
    main()
