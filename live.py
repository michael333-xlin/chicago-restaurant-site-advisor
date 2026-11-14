"""Live data layer: validate, enrich, de-duplicate and store fresh records (e.g. extracted from Exa results).

Four record kinds, stored append-only as JSONL under data/live/<kind>.jsonl:

  places   a restaurant opened or closed      -> updates supply counts / competition before scoring
  rents    an asking rent observation          -> overrides finance rent; can create a new area from a ZIP
  prices   a menu price / average ticket       -> replaces the finance model's estimated ticket
  signals  a news item (development, policy..) -> attached to the recommendation for the AI report

Every record must carry `source_url`; the engine shows these URLs as sources.

    from live import LiveStore
    LiveStore().ingest("rents", [{"zip5": "60607", "area": "West Loop", "rent_psf_year": 42,
                                  "observed_date": "2026-11-01", "source_url": "https://..."}], extractor="agent")
"""
import hashlib
import json
import pickle
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.path import Path as MplPath

from common import CUISINES, FIN_MAP, NON_REST, OUT, RAW, ROOT, _LOOKUP, norm_name

LIVE_DIR = ROOT / "data" / "live"
KINDS = ("places", "rents", "prices", "signals")
DEFAULT_CONFIDENCE = {"agent": 0.8, "manual": 0.9, "regex_baseline": 0.4}
SIGNAL_KINDS = {"development", "opening", "closure", "policy", "traffic", "other"}

# field -> (type, required). "geo" means: lat+lon, or zip5, is required.
SCHEMAS = {
    "places": {"name": (str, True), "status": (str, True), "event_date": ("date", True), "source_url": (str, True),
               "cuisine": (str, False), "address": (str, False), "zip5": (str, False),
               "lat": (float, False), "lon": (float, False), "_geo": True},
    "rents": {"rent_psf_year": (float, True), "observed_date": ("date", True), "source_url": (str, True),
              "area": (str, False), "zip5": (str, False), "address": (str, False),
              "lat": (float, False), "lon": (float, False), "space_type": (str, False), "_geo": True},
    "prices": {"observed_date": ("date", True), "source_url": (str, True), "avg_ticket_usd": (float, False),
               "avg_entree_usd": (float, False), "restaurant_name": (str, False), "cuisine": (str, False),
               "area": (str, False), "zip5": (str, False), "lat": (float, False), "lon": (float, False), "_geo": True},
    "signals": {"title": (str, True), "published_date": ("date", True), "source_url": (str, True),
                "kind": (str, False), "summary": (str, False), "area": (str, False), "zip5": (str, False),
                "sentiment": (float, False), "_geo": False},
}
RANGES = {"rent_psf_year": (5, 200), "avg_ticket_usd": (3, 400), "avg_entree_usd": (3, 300), "sentiment": (-1, 1),
          "lat": (41.6, 42.1), "lon": (-88.0, -87.5)}
TICKET_PER_ENTREE = 1.25   # average check ~= entree price + drinks/sides (team estimate, documented)


# ------------------------------------------------------------------ geography helpers
class ZipGeo:
    def __init__(self):
        g = json.loads((RAW / "zips" / "zips.geojson").read_text())
        self.rings, self.centroid = {}, {}
        for f in g["features"]:
            z, geom = f["properties"]["zip"], f["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            outer = [np.array(p[0]) for p in polys]
            self.rings[z] = outer
            big = max(outer, key=len)
            self.centroid[z] = (float(big[:, 1].mean()), float(big[:, 0].mean()))

    def zip_of(self, lat, lon):
        for z, rings in self.rings.items():
            if any(MplPath(r).contains_point((lon, lat)) for r in rings):
                return z
        return None

    def largest_ring(self, z):
        return max(self.rings[z], key=len)


_ZIPGEO = None


def zipgeo():
    global _ZIPGEO
    if _ZIPGEO is None:
        _ZIPGEO = ZipGeo()
    return _ZIPGEO


# ------------------------------------------------------------------ cuisine normalisation
_CLF = None


def classify_names(names):
    """Cuisine group from business names, using the step1 classifier."""
    global _CLF
    if _CLF is None:
        _CLF = pickle.load(open(OUT / "cuisine_classifier.pkl", "rb"))
    from scipy.sparse import hstack
    nn = [norm_name(n) for n in names]
    X = hstack([_CLF["v_char"].transform(nn), _CLF["v_word"].transform(nn)]).tocsr()
    P = _CLF["clf"].predict_proba(X)
    cls = _CLF["clf"].classes_
    return [(cls[i], float(P[k, i])) for k, i in enumerate(P.argmax(1))]


def normalize_cuisine(text):
    """'Thai' / 'thai_restaurant' / 'other_asian' / 'asian' (finance type) -> model group or None."""
    if not text:
        return None
    t = str(text).strip().lower().replace(" ", "_").replace("-", "_")
    if t in CUISINES:
        return t
    if t in _LOOKUP:
        return _LOOKUP[t]
    if t in FIN_MAP:            # finance type given: keep it, engine maps it
        return t
    return None


# ------------------------------------------------------------------ store
def _parse_date(v):
    if isinstance(v, (date, datetime)):
        return v.strftime("%Y-%m-%d")
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")[:25]).strftime("%Y-%m-%d")


class LiveStore:
    def __init__(self, root=LIVE_DIR):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _file(self, kind):
        return self.root / f"{kind}.jsonl"

    def _ids(self, kind):
        f = self._file(kind)
        if not f.exists():
            return set()
        return {json.loads(l)["id"] for l in f.read_text().splitlines() if l.strip()}

    # -------------------------------------------------- validation
    def validate(self, kind, rec):
        """Returns (clean_record, errors). Enriches geo and cuisine where possible."""
        if kind not in SCHEMAS:
            return None, [f"unknown kind {kind}; expected one of {KINDS}"]
        schema, errs, out = SCHEMAS[kind], [], {}
        for field, spec in schema.items():
            if field.startswith("_"):
                continue
            typ, req = spec
            v = rec.get(field)
            if v is None or v == "":
                if req:
                    errs.append(f"missing {field}")
                continue
            try:
                if typ == "date":
                    v = _parse_date(v)
                elif typ is float:
                    v = float(v)
                    lo, hi = RANGES.get(field, (-np.inf, np.inf))
                    if not lo <= v <= hi:
                        errs.append(f"{field}={v} outside [{lo}, {hi}]")
                else:
                    v = str(v).strip()
            except (TypeError, ValueError):
                errs.append(f"bad {field}: {v!r}")
                continue
            out[field] = v
        if "source_url" in out and not out["source_url"].startswith(("http://", "https://")):
            errs.append("source_url must be http(s)")

        # kind-specific rules
        if kind == "places":
            out["status"] = out.get("status", "").lower()
            if out["status"] not in {"open", "closed"}:
                errs.append("status must be 'open' or 'closed'")
        if kind == "prices" and "avg_ticket_usd" not in out and "avg_entree_usd" not in out:
            errs.append("need avg_ticket_usd or avg_entree_usd")
        if kind == "prices" and "avg_ticket_usd" not in out and "avg_entree_usd" in out:
            out["avg_ticket_usd"] = round(out["avg_entree_usd"] * TICKET_PER_ENTREE, 2)
            out["ticket_derived_from_entree"] = True
        if kind == "signals":
            out["kind"] = out.get("kind", "other").lower()
            if out["kind"] not in SIGNAL_KINDS:
                out["kind"] = "other"

        # geo enrichment
        if "zip5" in out:
            out["zip5"] = out["zip5"][:5]
        if "lat" in out and "lon" in out and "zip5" not in out:
            z = zipgeo().zip_of(out["lat"], out["lon"])
            if z:
                out["zip5"] = z
        if "zip5" in out and ("lat" not in out or "lon" not in out) and kind != "signals":
            if out["zip5"] in zipgeo().centroid:
                out["lat"], out["lon"] = zipgeo().centroid[out["zip5"]]
                out["geo_precision"] = "zip_centroid"
        if "zip5" in out and out["zip5"] not in zipgeo().rings:
            errs.append(f"zip5 {out['zip5']} is not a Chicago ZIP")
        if schema["_geo"] and not ({"lat", "lon"} <= out.keys() or "zip5" in out or "area" in out):
            errs.append("need lat+lon, zip5 or area")
        if kind == "places" and "lat" not in out:
            errs.append("places need lat+lon or zip5")

        # cuisine enrichment
        if kind in ("places", "prices"):
            c = normalize_cuisine(out.get("cuisine"))
            name = out.get("name") or out.get("restaurant_name")
            if c is None and name:
                g, p = classify_names([name])[0]
                if g != NON_REST and p >= 0.5:
                    c, out["cuisine_from_classifier"] = g, round(p, 3)
            if c:
                out["cuisine"] = c
            elif kind == "places":
                out["cuisine"] = None   # still counts toward total restaurants
        return out, errs

    # -------------------------------------------------- write
    def ingest(self, kind, records, extractor="agent", confidence=None):
        """Validate + store. Returns a report the agent can read back."""
        seen = self._ids(kind)
        accepted, dups, rejected = [], 0, []
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for i, rec in enumerate(records):
            clean, errs = self.validate(kind, rec)
            if errs:
                rejected.append({"index": i, "errors": errs})
                continue
            key = json.dumps({k: clean.get(k) for k in sorted(clean) if not k.startswith("cuisine_from")}, sort_keys=True)
            rid = hashlib.sha1(f"{kind}|{key}".encode()).hexdigest()[:16]
            if rid in seen:
                dups += 1
                continue
            seen.add(rid)
            clean.update({"id": rid, "record_kind": kind, "extractor": extractor, "ingested_at": now,
                          "confidence": confidence if confidence is not None else DEFAULT_CONFIDENCE.get(extractor, 0.5)})
            accepted.append(clean)
        if accepted:
            with self._file(kind).open("a") as f:
                for r in accepted:
                    f.write(json.dumps(r) + "\n")
        return {"kind": kind, "accepted": len(accepted), "duplicates": dups, "rejected": rejected,
                "ids": [r["id"] for r in accepted]}

    # -------------------------------------------------- read
    def load(self, kind, max_age_days=None, min_confidence=0.0):
        f = self._file(kind)
        if not f.exists():
            return pd.DataFrame()
        df = pd.DataFrame([json.loads(l) for l in f.read_text().splitlines() if l.strip()])
        if df.empty:
            return df
        dcol = {"places": "event_date", "rents": "observed_date", "prices": "observed_date",
                "signals": "published_date"}[kind]
        df[dcol] = pd.to_datetime(df[dcol])
        if max_age_days is not None:
            df = df[df[dcol] >= pd.Timestamp.now() - pd.Timedelta(days=max_age_days)]
        if "confidence" in df:
            df = df[df.confidence >= min_confidence]
        return df.reset_index(drop=True)

    def summary(self):
        out = {}
        for k in KINDS:
            df = self.load(k)
            out[k] = {"n": int(len(df)),
                      "latest_ingested": None if df.empty else str(df.ingested_at.max())}
        return out
