"""Export real block data for the web app (replaces the synthetic web/src/data/sample.ts generator).

Writes to output/web_data/ (served at /data/ by server/app.py):
  meta.json            sources, snapshot id, model version, rent per ZIP, gap reliability per cuisine
  overview.json        one H3 res-8 cell per ~0.7 km2 for the city map: [{h3, zip, block}]
  blocks/<zip>.json    every H3 res-10 cell inside the ZIP: [Block, ...]   (web/src/types.ts Block)
  evidence/<zip>.json  live records (rents, prices, places, signals) with source links

Every block value is summed over the cell and its two surrounding rings (~300 m), like the frontend expects.
Live records in data/live/ are applied on every export (rents -> ZIP rent, opened/closed places -> counts).

    python3 advantage/export_web.py              # full export (~1 min)
    python3 advantage/export_web.py --zips 60614 60647
"""
import argparse
import json
import re
from datetime import datetime, timezone

import h3
import numpy as np
import pandas as pd

from common import CUISINES, FIN_MAP, NON_REST, NOW, OUT, RAW, ROOT, addr_norm, load_overture, norm_name  # noqa: F401
from features import DATA_LAG, load_zip_panel, zip_year
from gapmodel import GAP_FEATS, loo_expected
from live import LiveStore

WEB = ["italian", "steakhouse", "fast_food", "asian"]          # web/src/types.ts Cuisine
GROUP_TO_WEB = {g: c for c in WEB for g in ({"italian": ["italian", "pizza"]}.get(c) or FIN_MAP[c])}
RES, RING = 10, 2
TRANSIT_M = 400
HIST_YEARS = range(2018, 2023)
K_SHRINK = 10
OUT_DIR = OUT / "web_data"
ZIPS_JSON = ROOT / "web" / "src" / "data" / "chicago_zips.json"
EARTH_R = 6_371_000.0


def _write(path, text):
    """Write atomically so the server never serves a half-written file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


def cell(lat, lon):
    return [h3.latlng_to_cell(a, b, RES) for a, b in zip(lat, lon)]


def zip_cells(z, res=RES):
    out = []
    for ring in z["polygons"]:
        poly = h3.LatLngPoly([(lat, lng) for lng, lat in ring])
        out.extend(h3.polygon_to_cells(poly, res))
    return list(dict.fromkeys(out))


class RingSum:
    """Per-cell point aggregates, summed over grid_disk(cell, RING) on request."""

    def __init__(self, cells, values):
        df = pd.DataFrame(values)
        df["cell"] = cells
        self.cols = [c for c in df.columns if c != "cell"]
        agg = df.groupby("cell")[self.cols].sum()
        self.idx = {c: i for i, c in enumerate(agg.index)}
        self.mat = agg.values.astype(float)

    def ring(self, c, k=RING):
        rows = [self.idx[n] for n in h3.grid_disk(c, k) if n in self.idx]
        s = self.mat[rows].sum(0) if rows else np.zeros(len(self.cols))
        return dict(zip(self.cols, s))


def load_sources(live):
    ov = load_overture()
    ov = ov[ov.lat.notna()].copy()
    ov["web"] = ov.cuisine.map(GROUP_TO_WEB)
    ov["name_norm"] = ov.restaurant_name.map(norm_name)
    applied = {"opened": 0, "closed": 0, "skipped": 0}
    pl = live.load("places")
    for _, r in pl.sort_values("event_date").iterrows() if not pl.empty else []:
        m = ov[(ov.name_norm == norm_name(r["name"])) & (ov.zip5 == r.get("zip5"))]
        if r["status"] == "open" and m.empty:
            ov = pd.concat([ov, pd.DataFrame([{"restaurant_name": r["name"], "name_norm": norm_name(r["name"]),
                                               "zip5": r.get("zip5"), "lat": r["lat"], "lon": r["lon"],
                                               "cuisine": r.get("cuisine"),
                                               "web": GROUP_TO_WEB.get(r.get("cuisine"), r.get("cuisine") if r.get("cuisine") in WEB else None)}])],
                           ignore_index=True)
            applied["opened"] += 1
        elif r["status"] == "closed" and not m.empty:
            ov = ov.drop(m.index[:1])
            applied["closed"] += 1
        else:
            applied["skipped"] += 1
    return ov, applied


def dry_precincts():
    """Polygons (lon, lat rings) of precincts with STATUS = dry in the city's historical dry-precinct KML."""
    import xml.etree.ElementTree as ET
    f = RAW / "liquor" / "dry_precincts.kml"
    if not f.exists():
        raise FileNotFoundError(f"{f} missing: run advantage/step0_download.sh")
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    rings = []
    for pm in ET.parse(f).getroot().findall(".//k:Placemark", ns):
        m = re.search(r"Status</td>\s*<td>\s*([A-Za-z]+)", pm.findtext("k:description", default="", namespaces=ns))
        if not m or m.group(1).lower() != "dry":
            continue
        for c in pm.findall(".//k:outerBoundaryIs//k:coordinates", ns):
            rings.append(np.array([[float(v) for v in pt.split(",")[:2]] for pt in c.text.split()]))
    return rings


def license_points():
    sp = pd.read_parquet(OUT / "license_spans.parquet")
    sp = sp[sp.start <= NOW]
    rest = sp.business_activity.str.contains("Dining|Prepared Onsite", na=False) | ((1 - sp[f"p_{NON_REST}"].fillna(1)) >= 0.5)
    last = sp.sort_values("start").groupby("license_number").agg(
        first_start=("start", "min"), final_end=("end", "max"), lat=("lat", "last"), lon=("lon", "last"),
        address=("address", "last"), **{f"p_{g}": (f"p_{g}", "last") for g in CUISINES})
    last["restaurant"] = rest.groupby(sp.license_number).any().reindex(last.index).fillna(False)
    last = last.dropna(subset=["lat", "lon"])
    t = NOW
    last["active"] = last.final_end > t
    last["closed12"] = (last.final_end <= t) & (last.final_end > t - pd.Timedelta(days=365)) & last.restaurant
    last["opened12"] = (last.first_start > t - pd.Timedelta(days=365)) & last.restaurant
    for c in WEB:
        groups = ["italian", "pizza"] if c == "italian" else FIN_MAP[c]
        last[f"pw_{c}"] = last[[f"p_{g}" for g in groups]].sum(axis=1)
    # closures per address since 2013 (restaurant licenses whose final record expired)
    a = last[last.restaurant & ~last.active & (last.final_end >= "2013-01-01")]
    last["addr"] = last.address.map(addr_norm)
    per_addr = last.loc[a.index].groupby("addr").size()
    last["addr_closures"] = last.addr.map(per_addr).fillna(0)
    return last


def build(zips_only=None):
    live = LiveStore()
    zips = json.loads(ZIPS_JSON.read_text())
    zips = [z for z in zips if not zips_only or z["zip"] in zips_only] if zips_only else zips
    panel = load_zip_panel()
    zctx = zip_year(panel, NOW.year - DATA_LAG)

    ov, applied = load_sources(live)
    lic = license_points()

    # ---- restaurants (Overture) per cell
    ovc = cell(ov.lat.values, ov.lon.values)
    vals = {"restaurants": np.ones(len(ov))}
    for c in WEB:
        vals[f"act_{c}"] = (ov.web == c).astype(float).values
    rs_ov = RingSum(ovc, vals)

    # ---- licenses per cell
    lc = cell(lic.lat.values, lic.lon.values)
    lv = {"food_active": lic.active.astype(float).values,
          "rest_closed12": lic.closed12.astype(float).values}
    for c in WEB:
        lv[f"open12_{c}"] = (lic.opened12 * lic[f"pw_{c}"]).values
        lv[f"close12_{c}"] = (lic.closed12 * lic[f"pw_{c}"]).values
    rs_lic = RingSum(lc, lv)
    closed_recent = lic[lic.closed12].assign(cell=[c for c, f in zip(lc, lic.closed12) if f])
    addr_by_cell = closed_recent.groupby("cell").addr_closures.max().to_dict()

    # ---- historical 1,000-day survival of openings (licenses), by web cuisine
    tbl = pd.read_parquet(OUT / "survival_training_table.parquet",
                          columns=["lat", "lon", "zip5", "cuisine", "year", "survived"])
    tbl = tbl[tbl.year.isin(HIST_YEARS)].copy()
    tbl["web"] = tbl.cuisine.map(GROUP_TO_WEB)
    tbl = tbl.dropna(subset=["web", "lat", "lon"])
    hv = {}
    for c in WEB:
        m = (tbl.web == c).values
        hv[f"n_{c}"] = m.astype(float)
        hv[f"fail_{c}"] = (m & (tbl.survived.values == 0)).astype(float)
    rs_hist = RingSum(cell(tbl.lat.values, tbl.lon.values), hv)
    overall_fail = float(1 - tbl.survived.mean())
    city_fail = {c: float(((1 - tbl[tbl.web == c].survived).sum() + K_SHRINK * overall_fail)
                          / ((tbl.web == c).sum() + K_SHRINK)) for c in WEB}
    zip_fail = {}
    for (z5, c), g in tbl.groupby(["zip5", "web"]):
        zip_fail[(z5, c)] = ((1 - g.survived).sum() + K_SHRINK * city_fail[c]) / (len(g) + K_SHRINK)

    # ---- jobs (WAC, data year NOW-2) and residents / earnings (RAC) per cell
    xw = pd.read_csv(RAW / "lodes" / "il_xwalk.csv.gz", usecols=["tabblk2020", "zcta", "blklatdd", "blklondd"],
                     dtype={"tabblk2020": str, "zcta": str})
    xw = xw[xw.zcta.fillna("").str.startswith("606")]
    wac_year = min(NOW.year - DATA_LAG, max(int(p.name.split("_")[-1][:4]) for p in RAW.glob("lodes/il_wac_*.csv.gz")))
    wac = pd.read_csv(RAW / "lodes" / f"il_wac_{wac_year}.csv.gz", usecols=["w_geocode", "C000"],
                      dtype={"w_geocode": str}).merge(xw, left_on="w_geocode", right_on="tabblk2020")
    rs_jobs = RingSum(cell(wac.blklatdd.values, wac.blklondd.values), {"jobs": wac.C000.values})
    rac_file = sorted(RAW.glob("lodes/il_rac_*.csv.gz"))[-1]
    rac = pd.read_csv(rac_file, usecols=["h_geocode", "C000", "CE03"], dtype={"h_geocode": str}) \
        .merge(xw, left_on="h_geocode", right_on="tabblk2020")
    pop = zctx["pop"]
    rac_tot = rac.groupby("zcta").C000.sum()
    both = pop.dropna().index.intersection(rac_tot.index)
    city_scale = float(pop.loc[both].sum() / rac_tot.loc[both].sum())   # citywide residents per resident worker
    scale = (pop / rac_tot).reindex(rac.zcta).values               # residents per resident worker, by ZIP
    rac["residents"] = rac.C000 * np.where(np.isnan(scale), city_scale, scale)
    rs_rac = RingSum(cell(rac.blklatdd.values, rac.blklondd.values),
                     {"residents": rac.residents.values, "rac_c000": rac.C000.values, "rac_ce03": rac.CE03.values})

    # ---- transit: average weekday L entries within TRANSIT_M of the cell centre
    stops = pd.read_csv(RAW / "cta" / "stops.csv", dtype={"map_id": str})
    ll = stops.location.astype(str).str.extract(r"\(?\s*([-\d.]+)\s*,\s*([-\d.]+)")
    stops["lat"], stops["lon"] = pd.to_numeric(ll[0], errors="coerce"), pd.to_numeric(ll[1], errors="coerce")
    st = stops.dropna(subset=["lat"]).groupby("map_id")[["lat", "lon"]].mean()
    rides = pd.read_csv(RAW / "cta" / "weekday_rides.csv", dtype={"station_id": str}).set_index("station_id").avg_weekday_rides
    st["rides"] = rides.reindex(st.index).fillna(0)
    from sklearn.neighbors import BallTree
    st_tree = BallTree(np.radians(st[["lat", "lon"]].values), metric="haversine")
    cta_window = (RAW / "cta" / "window.txt").read_text().split() if (RAW / "cta" / "window.txt").exists() else ["?", "?"]

    # ---- dry precincts (no liquor license can be issued): block centre inside a dry precinct polygon
    from matplotlib.path import Path as MplPath
    dry = [(MplPath(r), r[:, 0].min(), r[:, 0].max(), r[:, 1].min(), r[:, 1].max()) for r in dry_precincts()]

    def in_dry(lat, lon):
        return any(x0 <= lon <= x1 and y0 <= lat <= y1 and pth.contains_point((lon, lat)) for pth, x0, x1, y0, y1 in dry)

    # ---- ZIP-level: gap model for the 4 web cuisines, rent, age, model survival estimate
    chi_zips = [z["zip"] for z in json.loads(ZIPS_JSON.read_text())]
    ovz = ov[ov.zip5.isin(chi_zips)]
    counts = pd.DataFrame({c: (ovz.web == c).groupby(ovz.zip5).sum() for c in WEB}).fillna(0)
    total = ovz.groupby("zip5").size()
    fit_z = total[(total >= 30) & total.index.isin(zctx.index)].index
    expected, corr = loo_expected(counts.loc[fit_z], total.loc[fit_z], zctx.loc[fit_z, GAP_FEATS])
    exp_share = (expected.div(total.loc[fit_z], axis=0)).to_dict("index")
    city_share = {c: float(counts[c].sum() / total.sum()) for c in WEB}

    cai = pd.read_csv(OUT / "competitive_advantage_by_zip_cuisine.csv", dtype={"zip5": str})
    cai["web"] = cai.cuisine.map(GROUP_TO_WEB)
    surv_model = {(z5, c): float(np.average(g.p_license_1000d, weights=g.expected + 1))
                  for (z5, c), g in cai.dropna(subset=["web"]).groupby(["zip5", "web"])}

    rents_area = json.loads((ROOT / "finance" / "rent_by_area.json").read_text())
    from live import MIN_RENT_N, RENT_MIN_CONFIDENCE
    live_all = live.load("rents")
    live_r = live.load("rents", min_confidence=RENT_MIN_CONFIDENCE)   # pattern-extracted rents: evidence only
    fallback = float(np.median([v["rent_psf_year"] for v in rents_area.values()]))
    rent_by_zip = {}
    for z5 in chi_zips:
        lr = live_r[live_r.zip5 == z5] if not live_r.empty and "zip5" in live_r else pd.DataFrame()
        n_ev = int((live_all.zip5 == z5).sum()) if not live_all.empty and "zip5" in live_all else 0
        areas = [(k, v) for k, v in rents_area.items() if z5 in v.get("zip_codes", [])]
        if len(lr) >= MIN_RENT_N:
            rent_by_zip[z5] = {"psf": round(float(lr.rent_psf_year.median()), 1), "kind": "live", "n": int(len(lr)),
                               "source": f"Live asking rents ({len(lr)} observations, latest {lr.observed_date.max():%Y-%m-%d})",
                               "urls": lr.source_url.tolist()[:8]}
        elif areas:
            rent_by_zip[z5] = {"psf": round(float(np.median([v["rent_psf_year"] for _, v in areas])), 1), "kind": "survey",
                               "source": "finance/rent_by_area.json: " + "; ".join(f"{k}: {v['source']}" for k, v in areas),
                               "urls": []}
        else:
            rent_by_zip[z5] = {"psf": round(fallback, 1), "kind": "fallback", "urls": [],
                               "source": f"No local listing yet: citywide median of the {len(rents_area)} surveyed areas"}
        if n_ev and rent_by_zip[z5]["kind"] != "live":
            rent_by_zip[z5]["source"] += (f" ({n_ev} live rent observation(s) shown as evidence only: replacing the rent "
                                          f"needs {MIN_RENT_N}+ agent/manual records)")

    def block(c, z5):
        lat, lon = h3.cell_to_latlng(c)
        o, l, j, r, hh = rs_ov.ring(c), rs_lic.ring(c), rs_jobs.ring(c), rs_rac.ring(c), rs_hist.ring(c)
        near = rs_ov.ring(c, 1)["restaurants"] + rs_lic.ring(c, 1)["food_active"]
        share = exp_share.get(z5)
        cuis = {}
        for cu in WEB:
            sh = share[cu] if share else city_share[cu]
            n, f = hh[f"n_{cu}"], hh[f"fail_{cu}"]
            prior = zip_fail.get((z5, cu), city_fail[cu])
            cuis[cu] = {"expected": round(o["restaurants"] * sh, 2), "actual": int(o[f"act_{cu}"]),
                        "opened12m": int(round(l[f"open12_{cu}"])), "closed12m": int(round(l[f"close12_{cu}"])),
                        "closureRate1000d": round(float((f + K_SHRINK * prior) / (n + K_SHRINK)), 3),
                        "historyN": int(n),
                        "survivalModel1000d": round(surv_model.get((z5, cu), np.nan), 3) if (z5, cu) in surv_model else None}
        ridx = st_tree.query_radius(np.radians([[lat, lon]]), r=TRANSIT_M / EARTH_R)[0]
        return {
            "h3": c, "lat": round(lat, 6), "lon": round(lon, 6), "zip": z5,
            "commercial": float(near), "eligible": bool(near >= 1 and o["restaurants"] + l["food_active"] >= 3),
            "residents": int(round(r["residents"])), "jobs": int(round(j["jobs"])),
            "highWageShare": round(float(r["rac_ce03"] / r["rac_c000"]), 3) if r["rac_c000"] > 0 else None,
            "incomePct": 0.0,
            "age18to39": round(float(zctx.sh_age_18_39.get(z5, np.nan)), 3) if z5 in zctx.index else None,
            "transitRiders": int(round(st.rides.values[ridx].sum())) if len(ridx) else 0,
            "restaurants": int(o["restaurants"]),
            "cuisine": cuis,
            "rentPsf": rent_by_zip.get(z5, {"psf": round(fallback, 1)})["psf"],
            "rentKind": rent_by_zip.get(z5, {"kind": "fallback"})["kind"],
            "liquorMoratorium": bool(in_dry(lat, lon)),
            "recentClosures": int(l["rest_closed12"]),
            "sameAddressClosures": int(max([addr_by_cell.get(n, 0) for n in h3.grid_disk(c, RING)] or [0])),
        }

    # ---- assemble
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "blocks").mkdir(exist_ok=True)
    (OUT_DIR / "evidence").mkdir(exist_ok=True)
    all_zips = json.loads(ZIPS_JSON.read_text())
    overview = []
    for z in all_zips:
        for h8 in zip_cells(z, 8):
            overview.append({"h3": h8, "zip": z["zip"], "block": block(h3.cell_to_center_child(h8, RES), z["zip"])})
    # percentiles: commercial and income are ranked against the citywide overview blocks
    ref_comm = np.sort([o["block"]["commercial"] for o in overview])
    ref_inc = np.sort([o["block"]["highWageShare"] for o in overview if o["block"]["highWageShare"] is not None])

    def finish(b):
        b["commercial"] = round(float(np.searchsorted(ref_comm, b["commercial"]) / max(len(ref_comm), 1)), 3)
        hw = b["highWageShare"]
        b["incomePct"] = round(float(100 * np.searchsorted(ref_inc, hw) / len(ref_inc)), 1) if hw is not None else 50.0
        return b

    for o in overview:
        finish(o["block"])
    _write(OUT_DIR / "overview.json", json.dumps(overview, separators=(",", ":")))

    stats = {}
    for z in zips:
        cells = zip_cells(z)
        blocks = [finish(block(c, z["zip"])) for c in cells]
        _write(OUT_DIR / "blocks" / f"{z['zip']}.json", json.dumps(blocks, separators=(",", ":")))
        stats[z["zip"]] = {"cells": len(blocks), "eligible": sum(b["eligible"] for b in blocks)}
        ev = {}
        for kind in ("rents", "prices", "places", "signals"):
            df = live.load(kind)
            if df.empty or "zip5" not in df:
                ev[kind] = []
                continue
            sub = df[df.zip5 == z["zip"]].copy()
            for col in sub.columns:
                if pd.api.types.is_datetime64_any_dtype(sub[col]):
                    sub[col] = sub[col].dt.strftime("%Y-%m-%d")
            ev[kind] = json.loads(sub.drop(columns=[c for c in ["lat", "lon"] if c in sub], errors="ignore")
                                  .to_json(orient="records"))
        ev["rent"] = rent_by_zip.get(z["zip"])
        _write(OUT_DIR / "evidence" / f"{z['zip']}.json", json.dumps(ev, separators=(",", ":"), default=str))

    import pickle
    bundle = pickle.load(open(OUT / "survival_model.pkl", "rb"))
    s2 = json.loads((OUT / "step2_survival_report.json").read_text())

    reg = json.loads((OUT / "model_registry.json").read_text()) if (OUT / "model_registry.json").exists() else []
    promoted = [r for r in reg if r.get("promoted")]
    from snapshot import snapshot_id
    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "asOf": NOW.strftime("%Y-%m-%d"), "snapshotId": snapshot_id(),
        "modelVersion": promoted[-1]["version"] if promoted else None,
        "notice": f"Real data · snapshot {NOW:%Y-%m-%d}",
        "gapReliability": {c: round(float(corr[c]), 3) for c in WEB},
        "rentByZip": rent_by_zip,
        "liveApplied": applied, "liveCounts": live.summary(),
        "ctaWindow": cta_window,
        "licenseCurve": {"S": [round(float(v), 4) for v in bundle["license_curve"]["S_city"]],
                         "S1000d": round(float(bundle["license_curve"]["S_city_1000d"]), 4),
                         "check": s2["license_curve"]["summary_by_month"]},
        "survivalModel": {"kind": bundle["kind"], "featureSet": bundle["feature_set"],
                          "aucIndependent": round(s2["final_model"]["auc_independent"], 3),
                          "aucAll": round(s2["final_model"]["auc_all"], 3),
                          "brier": round(s2["final_model"]["brier_all"], 4),
                          "brierConstant": round(s2["final_model"]["brier_constant_all"], 4)},
        "sources": {
            "restaurants": "Overture Maps places (chicago_restaurant_categories.csv, 11,875 places), CDLA-Permissive-2.0",
            "expected": "Leave-one-ZIP-out Poisson model (ZIP population, jobs, income, age) × restaurants within ~300 m",
            "openings_closures": "Chicago Business Licenses r5kz-chrr (Retail Food), last 12 months; cuisine from a name classifier",
            "closure_rate": f"Share of {HIST_YEARS[0]}-{HIST_YEARS[-1]} openings whose license did not reach 1,000 days, shrunk toward ZIP and city",
            "jobs": f"LEHD LODES8 WAC {wac_year}",
            "residents": f"LEHD LODES8 RAC {rac_file.stem.split('_')[-1].split('.')[0]} resident workers scaled to ZIP population (Chicago Population Counts 85cm-7uqa)",
            "income": "Share of employed residents earning > $3,333/month (LODES RAC CE03); percentile vs city",
            "age": "ZIP share aged 18-39 (Chicago Population Counts)",
            "transit": f"CTA 'L' average weekday entries {cta_window[0]} to {cta_window[1]} (5neh-572f) within 400 m",
            "rent": "Live listings via Exa (3+ agent/manual records) > finance/rent_by_area.json survey > citywide median fallback",
            "liquor": "Dry precincts: City of Chicago Liquor Moratorium Districts - Dry Precincts (y49e-jumb), a historical "
                      "2011 dataset; precinct boundaries may have changed since, confirm with BACP",
            "survival": "1,000-day license survival model (step2, rolling out-of-time validated) for a new independent "
                        "dine-in opening; license curve = Kaplan-Meier of license durations, scaled per site",
            "not_available": "Hotel rooms and student share are not connected",
        },
        "zips": stats,
    }
    _write(OUT_DIR / "meta.json", json.dumps(meta, indent=1, default=str))
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--zips", nargs="*")
    a = ap.parse_args()
    m = build(set(a.zips) if a.zips else None)
    print(json.dumps({k: m[k] for k in ["generatedAt", "snapshotId", "modelVersion", "gapReliability", "liveApplied"]}, indent=1))
    print("zips:", len(m["zips"]), "cells:", sum(v["cells"] for v in m["zips"].values()),
          "eligible:", sum(v["eligible"] for v in m["zips"].values()))
