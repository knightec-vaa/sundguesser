#!/usr/bin/env python3
"""One-time setup: generate a local encryption key for the location pool.

Run this once when setting up your local dev environment:

    python3 tools/init_key.py

It writes secrets/key.txt (gitignored). Copy the printed value into a
GitHub Actions repository secret named SUPERSECRETKEY so CI can use the same
key to decrypt/encrypt the pool and to inject it into the deployed site.
"""
from crypto_lib import SECRETS_DIR, KEY_FILE, generate_key_b64


def main():
    SECRETS_DIR.mkdir(exist_ok=True)
    if KEY_FILE.exists():
        print(f"Key already exists at {KEY_FILE}, not overwriting.")
        print("Current key:")
        print(KEY_FILE.read_text().strip())
        return
    key = generate_key_b64()
    KEY_FILE.write_text(key + "\n")
    print(f"Generated new key and saved to {KEY_FILE}")
    print()
    print("Add this exact value as a GitHub repository secret named SUPERSECRETKEY:")
    print(key)


if __name__ == "__main__":
    main()
