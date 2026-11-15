"""Fixed raw-data snapshot: hashes every file under data/raw/ so runs can be compared on identical inputs.

    python3 advantage/snapshot.py write    # after downloading: writes data/raw/MANIFEST.json
    python3 advantage/snapshot.py check    # verifies data/raw/ still matches the manifest
Every step report includes `snapshot_id` (hash of the manifest) - only compare reports with the same id.
"""
import hashlib
import json
import sys

from common import OVERTURE_CSV, RAW

MANIFEST = RAW / "MANIFEST.json"


def _sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build():
    files = {str(p.relative_to(RAW)): {"sha256": _sha(p), "bytes": p.stat().st_size}
             for p in sorted(RAW.rglob("*")) if p.is_file() and p.name != "MANIFEST.json"}
    if OVERTURE_CSV.exists():
        files["overture:" + OVERTURE_CSV.name] = {"sha256": _sha(OVERTURE_CSV), "bytes": OVERTURE_CSV.stat().st_size}
    return files


def snapshot_id():
    if not MANIFEST.exists():
        return None
    return hashlib.sha256(MANIFEST.read_bytes()).hexdigest()[:12]


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "write":
        MANIFEST.write_text(json.dumps(build(), indent=1, sort_keys=True))
        print("snapshot_id", snapshot_id(), "files", len(json.loads(MANIFEST.read_text())))
    else:
        old, new = json.loads(MANIFEST.read_text()), build()
        diff = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
        print("snapshot_id", snapshot_id(), "OK" if not diff else f"CHANGED: {diff}")
        sys.exit(1 if diff else 0)
