"""Recommendation engine: budget + restaurant type -> where to open, how big, payback, risks.

Covers product features 1-5 (site ranking, competition, customer fit, ROI, risk / stress test).
Every number in the output carries a `sources` entry. Needs step1-step3 outputs in output/.

    python3 advantage/recommend.py --budget 350000 --cuisine asian
    python3 advantage/recommend.py --budget 250000 --cuisine fast_food --traffic 0.7 --food 1.15 --space second_gen

From Python (e.g. a web backend or the AI-advisor agent):
    from recommend import Engine
    result = Engine().recommend(350_000, "asian")                 # base data only
    result = Engine(live=LiveStore()).recommend(350_000, "asian")  # + live records from data/live/

Live overlay (see live.py): opened/closed places change supply counts and competition before scoring,
live rents override the finance rent (a rent for an unknown area/ZIP adds that ZIP as a new candidate area),
>= MIN_PRICE_N live prices replace the estimated ticket, and recent signals are attached for the AI report.
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
from matplotlib.path import Path as MplPath

from common import CUISINES, FIN_MAP, FINANCE_DIR, NOW, OUT, RAW, load_overture, norm_name
from gapmodel import score_cai
from features import DATA_LAG, load_zip_panel, zip_year

sys.path.insert(0, str(FINANCE_DIR))
from finance import calc, load  # noqa: E402

HIST_YEARS = range(2018, 2023)   # "last 5 years" of openings whose 3-year outcome is already observed
MIN_HIST_N = 20                   # below this, the neighborhood history falls back to its ZIPs
MIN_HIST_N_ZIP = 10               # below this, fall back to the citywide rate
MIN_PRICE_N = 3                   # live price observations needed before replacing the estimated ticket
LIVE_MAX_AGE_DAYS = 365
STRESS_TRAFFIC = 0.7              # stress scenario used in the ranking: 30% fewer customers

SOURCES = {
    "competition": "Overture Maps places snapshot (chicago_restaurant_categories.csv), points inside the neighborhood polygon",
    "gap": "Similar-area cuisine supply baseline difference: leave-one-ZIP-out Poisson model on Overture counts + ZIP demographics (advantage/step3); backtest in step4",
    "survival_model": "1,000-day license survival, recalibrated model on Chicago Business Licenses r5kz-chrr openings 2013-2022; rolling out-of-time AUC ~0.61 for independents (advantage/step2). Not used in the score.",
    "survival_history": "Chicago Business Licenses r5kz-chrr: share of openings 2018-2022 still licensed after 1,000 days",
    "population": "Chicago Population Counts 85cm-7uqa (latest year 2021)",
    "jobs": f"LEHD LODES8 WAC Illinois, data year {NOW.year - DATA_LAG}",
    "income": "Chicago Census socioeconomic indicators by community area 2008-2012 (kn9c-c2s2)",
    "finance": "Team finance model finance/finance.py + cuisine_params.json (BLS, NRA, Toast etc.; see its sources field)",
    "rent": "finance/rent_by_area.json asking rents (see per-area source)",
}


def _km_xy(lon, lat, lat0=41.88):
    return np.c_[np.asarray(lon) * 111.32 * np.cos(np.radians(lat0)), np.asarray(lat) * 110.57]


def _area_km2(ring):
    xy = _km_xy(ring[:, 0], ring[:, 1])
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def _wavg(v, w):
    v, w = np.asarray(v, float), np.asarray(w, float)
    m = ~np.isnan(v)
    return float(np.average(v[m], weights=w[m])) if m.any() and w[m].sum() > 0 else float("nan")


class Engine:
    def __init__(self, live=None, live_max_age_days=LIVE_MAX_AGE_DAYS, min_confidence=0.0):
        self.params, self.rents = load("cuisine_params.json"), load("rent_by_area.json")
        geo = json.loads((FINANCE_DIR / "neighborhoods.geojson").read_text())
        self.polys = {f["properties"]["name"]: np.array(f["geometry"]["coordinates"][0]) for f in geo["features"]}
        self.geo = geo
        self.cai = pd.read_csv(OUT / "competitive_advantage_by_zip_cuisine.csv", dtype={"zip5": str})
        self.hist = pd.read_parquet(OUT / "survival_training_table.parquet",
                                    columns=["lat", "lon", "zip5", "cuisine", "year", "survived"])
        self.ov = load_overture()
        self.z = zip_year(load_zip_panel(), NOW.year - DATA_LAG)
        chi = self.z.index[self.z.index.isin(self.cai.zip5.unique())]
        self.city_income = float(self.z.loc[chi, "income_pc"].median())
        self.city_share = {}  # citywide share of restaurants that are of each finance cuisine
        tot = self.cai.groupby("zip5").actual.sum().sum()
        for fc, groups in FIN_MAP.items():
            self.city_share[fc] = self.cai[self.cai.cuisine.isin(groups)].actual.sum() / tot
        self.area_boundary = {a: "neighborhood" for a in self.rents}
        self.live, self.live_report = live, {"used": False}
        self.live_prices = self.live_signals = pd.DataFrame()
        if live is not None:
            self._apply_live(live, live_max_age_days, min_confidence)

    # ---------------------------------------------------------------- live overlay
    def _apply_live(self, live, max_age, min_conf):
        rep = {"used": True, "max_age_days": max_age, "store": live.summary()}
        # 1) places: unmatched openings add supply, closures that match an Overture place remove it
        pl = live.load("places", max_age, min_conf)
        delta, opened, closed, skipped = {}, 0, 0, 0
        if not pl.empty:
            self.ov["name_norm"] = self.ov.restaurant_name.map(norm_name)
            for _, r in pl.sort_values("event_date").iterrows():
                nn, zz = norm_name(r["name"]), r.get("zip5")
                match = self.ov[(self.ov.name_norm == nn) & (self.ov.zip5 == zz)]
                c = r.get("cuisine") if r.get("cuisine") in CUISINES else None
                if r["status"] == "open":
                    if len(match):
                        skipped += 1          # already in the snapshot
                        continue
                    self.ov = pd.concat([self.ov, pd.DataFrame([{
                        "restaurant_name": r["name"], "name_norm": nn, "zip5": zz, "lat": r["lat"],
                        "lon": r["lon"], "cuisine": c, "live_id": r["id"]}])], ignore_index=True)
                    opened += 1
                    sign = 1
                else:
                    if not len(match):
                        skipped += 1          # cannot confirm it was counted
                        continue
                    self.ov = self.ov.drop(match.index[:1])
                    closed += 1
                    sign = -1
                    c = c or match.iloc[0].cuisine
                if c:
                    delta[(zz, c)] = delta.get((zz, c), 0) + sign
        if delta:
            self.cai["actual_base"] = self.cai.actual
            for (zz, c), d in delta.items():
                m = (self.cai.zip5 == zz) & (self.cai.cuisine == c)
                self.cai.loc[m, "actual"] = (self.cai.loc[m, "actual"] + d).clip(lower=0)
            self.cai = score_cai(self.cai)
        rep["places"] = {"opened_applied": opened, "closed_applied": closed, "skipped": skipped,
                         "zip_cuisine_cells_changed": len(delta)}

        # 2) rents: override known areas; a rent for an unknown area/ZIP creates a ZIP-boundary area
        from live import MIN_RENT_N, RENT_MIN_CONFIDENCE
        rn = live.load("rents", max_age, max(min_conf, RENT_MIN_CONFIDENCE))
        rep["rents"] = {"rule": f"agent/manual rents only (confidence >= {RENT_MIN_CONFIDENCE}), at least {MIN_RENT_N} per "
                                f"area; pattern-extracted rents are evidence only"}
        if not rn.empty:
            from live import zipgeo
            lower = {k.lower(): k for k in self.rents}
            rn["area_key"] = [lower.get(str(a).lower()) if isinstance(a, str) else None for a in rn.get("area", [None] * len(rn))]
            for i, r in rn.iterrows():
                if r.area_key is None and isinstance(r.get("zip5"), str):
                    known = [k for k, v in self.rents.items() if v.get("primary_zip") == r.zip5]
                    rn.at[i, "area_key"] = known[0] if known else (r.get("area") if isinstance(r.get("area"), str) else f"ZIP {r.zip5}")
            for key, g in rn.dropna(subset=["area_key"]).groupby("area_key"):
                if len(g) < MIN_RENT_N:
                    rep["rents"][key] = {"n": len(g), "used": False, "reason": f"fewer than {MIN_RENT_N} observations"}
                    continue
                med, urls = float(g.rent_psf_year.median()), g.source_url.tolist()
                src = f"live: median of {len(g)} asking-rent observations, latest {g.observed_date.max():%Y-%m-%d}: " + ", ".join(urls[:5])
                if key not in self.rents:
                    zz = g.zip5.dropna().iloc[0]
                    ring = zipgeo().largest_ring(zz)
                    self.polys[key] = ring
                    self.rents[key] = {"rent_psf_year": med, "income_index": 1.0, "demand_index": 1.0, "source": src,
                                       "lat": float(ring[:, 1].mean()), "lng": float(ring[:, 0].mean()),
                                       "zip_codes": [zz], "primary_zip": zz, "community_area": None}
                    self.area_boundary[key] = "zip"
                    rep["rents"][key] = {"rent_psf_year": med, "n": len(g), "new_area": True}
                else:
                    rep["rents"][key] = {"rent_psf_year": med, "n": len(g), "new_area": False,
                                         "replaced": self.rents[key]["rent_psf_year"]}
                    self.rents[key] = {**self.rents[key], "rent_psf_year": med, "source": src}
        # 3) prices and 4) signals are matched per area at recommend time
        self.live_prices = live.load("prices", max_age, min_conf)
        self.live_signals = live.load("signals", max_age, min_conf)
        rep["prices_available"], rep["signals_available"] = len(self.live_prices), len(self.live_signals)
        self.live_report = rep

    def _area_mask(self, df, area, zips):
        if df.empty:
            return np.zeros(0, bool)
        m = np.zeros(len(df), bool)
        if "area" in df:
            m |= df["area"].astype(str).str.lower().eq(area.lower()).values
        if "zip5" in df:
            m |= df["zip5"].isin(list(zips)).values
        if {"lat", "lon"} <= set(df.columns):
            ll = df[["lat", "lon"]].notna().all(axis=1).values
            if ll.any():
                m[ll] |= self._inside(area, df.lat.values[ll], df.lon.values[ll])
        return m

    def _prices_for(self, area, cuisine, zips):
        p = self.live_prices
        if p.empty:
            return None
        ok = p.cuisine.isin(FIN_MAP[cuisine] + [cuisine]).values if "cuisine" in p else np.zeros(len(p), bool)
        sub = p[self._area_mask(p, area, zips) & ok]
        if sub.empty:
            return None
        return {"n": int(len(sub)), "median_ticket_usd": round(float(sub.avg_ticket_usd.median()), 2),
                "used_as_ticket": len(sub) >= MIN_PRICE_N, "sources": sub.source_url.tolist()[:10]}

    def _signals_for(self, area, zips, k=5):
        sg = self.live_signals
        if sg.empty:
            return []
        sub = sg[self._area_mask(sg, area, zips)].sort_values("published_date", ascending=False).head(k)
        cols = [c for c in ["published_date", "kind", "title", "summary", "sentiment", "source_url"] if c in sub]
        return [{k2: (str(v)[:10] if k2 == "published_date" else v) for k2, v in r.items() if pd.notna(v)}
                for r in sub[cols].to_dict("records")]

    # ---------------------------------------------------------------- per-neighborhood facts
    def _inside(self, area, lat, lon):
        return MplPath(self.polys[area]).contains_points(np.c_[lon, lat])

    def _neighborhood(self, area, cuisine):
        groups, a = FIN_MAP[cuisine], self.rents[area]
        ov_in = self.ov[self._inside(area, self.ov.lat.values, self.ov.lon.values)]
        # ZIP weights = where the neighborhood's restaurants actually are
        w = ov_in.zip5.value_counts(normalize=True)
        w = w[w.index.isin(self.cai.zip5.unique())]
        if w.empty:
            w = pd.Series({a["primary_zip"]: 1.0})
        w = w / w.sum()

        sub = self.cai[self.cai.zip5.isin(w.index) & self.cai.cuisine.isin(groups)].copy()
        per_zip = sub.groupby("zip5").agg(actual=("actual", "sum"), expected=("expected", "sum"),
                                          total_w=("expected", lambda s: s.sum() + len(s)))
        sub["wz"] = sub.zip5.map(w) * (sub.expected + 1)
        actual = float((per_zip.actual * w).sum())
        expected = float((per_zip.expected * w).sum())
        cai = _wavg(sub.CAI, sub.wz)
        gap_score = _wavg(sub.gap_score, sub.wz)
        low_ev_share = _wavg(sub.low_evidence.astype(float), sub.wz)   # weight on pairs whose gap is unreliable
        p_surv = _wavg(sub.p_license_1000d, sub.wz)

        # competition inside the polygon
        area_km2 = _area_km2(self.polys[area])
        same = ov_in[ov_in.cuisine.isin(groups)]
        comp = {"same_type_count": int(len(same)), "all_restaurants": int(len(ov_in)),
                "area_km2": round(area_km2, 2),
                "same_type_per_km2": round(len(same) / area_km2, 1),
                "same_type_share": round(len(same) / max(len(ov_in), 1), 3),
                "zip_gap_actual": round(actual, 1), "zip_gap_expected": round(expected, 1),
                "zip_gap_missing": round(expected - actual, 1)}

        # historical survival, last 5 cohorts
        h = self.hist[self.hist.year.isin(HIST_YEARS) & self.hist.cuisine.isin(groups)]
        h_in = h[self._inside(area, h.lat.values, h.lon.values)]
        level = "neighborhood"
        if len(h_in) < MIN_HIST_N:
            h_in, level = h[h.zip5.isin(w.index)], "zip"
        if len(h_in) < MIN_HIST_N_ZIP:
            h_in, level = h, "city (too few local openings)"
        city = h.survived.mean()
        hist = {"rate": round(float(h_in.survived.mean()), 3) if len(h_in) else None, "n": int(len(h_in)),
                "level": level, "city_rate": round(float(city), 3), "years": f"{HIST_YEARS[0]}-{HIST_YEARS[-1]}"}

        # customers
        zz = self.z.loc[self.z.index.intersection(w.index)]
        ww = w.reindex(zz.index)
        inc = _wavg(zz.income_pc, ww)
        local_share = expected / max(float((self.cai[self.cai.zip5.isin(w.index)].groupby("zip5").actual.sum() * w).sum()), 1)
        demo = {"population": round(_wavg(zz["pop"], ww)), "jobs": round(_wavg(zz.jobs, ww)),
                "income_per_capita": round(inc), "income_vs_city": round(inc / self.city_income, 2),
                "share_age_18_39": round(_wavg(zz.sh_age_18_39, ww), 3),
                "jobs_per_resident": round(_wavg(zz.jobs_per_res, ww), 2),
                # >1: the demographics here predict MORE of this cuisine than the city average
                "fit_ratio": round(local_share / self.city_share[cuisine], 2)}
        return {"zip_weights": w.round(3).to_dict(), "cai": cai, "gap_score": gap_score, "gap_reliable": bool(low_ev_share < 0.5), "p_license_1000d": p_surv,
                "actual": actual, "expected": expected, "competition": comp, "history": hist, "demographics": demo}

    # ---------------------------------------------------------------- main entry
    def recommend(self, budget, cuisine, space_type="new", traffic_shock=1.0, food_shock=1.0, top_n=5,
                  prior_licenses=None, entity=None):
        """Budget filter -> rank by (supply gap, base-case payback, profit when traffic drops 30%).

        The 1,000-day license survival estimate is reported next to each area but is NOT part of the score
        (out-of-time AUC ~0.61 for independents). prior_licenses / entity are optional operator inputs: when given,
        the estimate is re-scored with them (survival.SiteSurvival); otherwise it uses the ZIP averages.
        """
        if cuisine not in FIN_MAP:
            raise ValueError(f"cuisine must be one of {list(FIN_MAP)}")
        person = {k: v for k, v in {"prior_licenses": prior_licenses, "entity": entity}.items() if v is not None}
        if person:
            from survival import SiteSurvival
            scorer = SiteSurvival()
        cands, excluded = [], []
        for area in self.rents:
            nb = self._neighborhood(area, cuisine)
            rents = {k: dict(v) for k, v in self.rents.items()}
            rents[area]["demand_index"] = float(np.clip(np.sqrt((nb["expected"] + 1) / (nb["actual"] + 1)), 0.8, 1.2))
            rents[area]["income_index"] = nb["demographics"]["income_vs_city"]
            prices = self._prices_for(area, cuisine, nb["zip_weights"].keys())
            ticket = round(prices["median_ticket_usd"]) if prices and prices["used_as_ticket"] else None
            kw = dict(space_type=space_type, food_shock=food_shock, ticket_override=ticket)
            r = calc(budget, cuisine, area, self.params, rents, traffic_shock=traffic_shock, **kw)
            if not r["feasible"]:
                excluded.append({"area": area, "reason": r["message"], "min_budget": r["min_budget"]})
                continue
            stress = calc(budget, cuisine, area, self.params, rents, traffic_shock=traffic_shock * STRESS_TRAFFIC, **kw)
            other = "second_gen" if space_type == "new" else "new"
            r_alt = calc(budget, cuisine, area, self.params, rents, traffic_shock=traffic_shock,
                         **{**kw, "space_type": other})
            b = r["scenarios"]["base"]
            cands.append({"area": area, "nb": nb, "r": r, "stress": stress, "r_alt": r_alt, "prices": prices,
                          "rents": rents, "other": other,
                          "gap": nb["gap_score"] if nb["gap_reliable"] else 50.0,
                          "payback": b["payback_months"] if b["payback_months"] else np.inf,
                          "stress_profit": stress["scenarios"]["base"]["monthly_profit"]})

        if cands:
            df = pd.DataFrame([{k: c[k] for k in ("gap", "payback", "stress_profit")} for c in cands])
            n = len(df)
            pct = (lambda s: (s.rank(method="average") - 1) / (n - 1) * 100) if n > 1 else (lambda s: s * 0 + 100)
            df["gap_pct"] = pct(df.gap)
            df["payback_pct"] = pct(-df.payback.replace(np.inf, 1e9))
            df["stress_pct"] = pct(df.stress_profit)
            df["score"] = df[["gap_pct", "payback_pct", "stress_pct"]].mean(axis=1)
        ranked = []
        for i, c in enumerate(cands):
            nb, r, st, b = c["nb"], c["r"], c["stress"], c["r"]["scenarios"]["base"]
            sb = st["scenarios"]["base"]
            p_model, p_inputs = nb["p_license_1000d"], "ZIP averages of recent independent openings"
            if person:
                zw = {z: w for z, w in nb["zip_weights"].items() if z in scorer.defaults["zips"]}
                if zw:
                    p_model = _wavg([scorer.score(z, cuisine, **person)["p_license_1000d"] for z in zw], list(zw.values()))
                    p_inputs = f"your inputs {person}; ZIP averages for the rest"
            ranked.append({
                "area": c["area"], "score": round(float(df.score[i]), 1),
                "subscores": {"supply_gap_pct": round(float(df.gap_pct[i]), 1),
                              "payback_pct": round(float(df.payback_pct[i]), 1),
                              "traffic_-30%_profit_pct": round(float(df.stress_pct[i]), 1)},
                "boundary": self.area_boundary.get(c["area"], "neighborhood"),
                "reasons": self._reasons(c["area"], cuisine, nb, r, st, c["prices"], p_model),
                "competition": {**nb["competition"], "gap_score": round(nb["gap_score"], 1),
                                "gap_reliable": nb["gap_reliable"]},
                "license_survival_1000d": {
                    "label": "1,000-day license survival estimate (not used in the score)",
                    "model_estimate": round(p_model, 3), "model_inputs": p_inputs,
                    "history": nb["history"],
                    "caveat": "license span >= 1,000 days; agrees with inspection-based operation ~85% of the time"},
                "demographics": nb["demographics"],
                "finance": {**r, "demand_index_used": round(c["rents"][c["area"]]["demand_index"], 3),
                            "income_index_used": c["rents"][c["area"]]["income_index"],
                            "rent_psf_year": self.rents[c["area"]]["rent_psf_year"],
                            "rent_source": self.rents[c["area"]]["source"]},
                "stress_test": {"traffic_multiplier": STRESS_TRAFFIC,
                                "monthly_profit_base": b["monthly_profit"], "monthly_profit_stressed": sb["monthly_profit"],
                                "payback_months_stressed": sb["payback_months"], "payback_note_stressed": sb["payback_note"],
                                "warnings_stressed": st["warnings"]},
                "risk": {"warnings": r["warnings"]},
                "space_comparison": {r["inputs"]["space_type"]: b["payback_months"],
                                     c["other"]: c["r_alt"]["scenarios"]["base"]["payback_months"] if c["r_alt"]["feasible"] else None,
                                     "note": "base-case payback months"},
                "zip_weights": nb["zip_weights"],
                "live": {"prices": c["prices"], "signals": self._signals_for(c["area"], nb["zip_weights"].keys())},
            })
        ranked.sort(key=lambda x: -x["score"])
        return {"inputs": {"budget": budget, "cuisine": cuisine, "space_type": space_type,
                           "traffic_shock": traffic_shock, "food_shock": food_shock, **person},
                "top": ranked[:top_n], "all_ranked": [{"area": x["area"], "score": x["score"]} for x in ranked],
                "excluded": excluded, "live_data": self.live_report, "method": {
                    "filter": "areas whose minimum store size does not fit the budget are excluded",
                    "score": "mean of three percentile ranks among the remaining areas: supply gap (higher better; "
                             "neutral 50 when the gap model is unreliable for this cuisine), base-case payback months "
                             f"(shorter better), monthly profit with traffic x{STRESS_TRAFFIC} (higher better)",
                    "supply_gap": "similar-area cuisine supply baseline difference: fewer places of this type than "
                                  "ZIPs with similar population/jobs/income and the same total restaurant count",
                    "license_survival_1000d": "shown separately, not in the score"},
                "sources": SOURCES}

    def _reasons(self, area, cuisine, nb, r, stress, prices=None, p_model=None):
        c, h, d, out = nb["competition"], nb["history"], nb["demographics"], []
        if self.area_boundary.get(area) == "zip":
            out.append("Candidate added from live rent data; boundary = whole ZIP")
        miss = c["zip_gap_missing"]
        if not nb["gap_reliable"]:
            out.append(f"Supply gap not used for {cuisine} (gap model unreliable for this type); counted as neutral")
        elif miss >= 1:
            out.append(f"Supply gap: {c['zip_gap_actual']:.0f} {cuisine} places in its ZIP(s) vs ~{c['zip_gap_expected']:.0f} "
                       f"in similar areas")
        elif miss <= -1:
            out.append(f"Crowded: {c['zip_gap_actual']:.0f} {cuisine} places in its ZIP(s) vs ~{c['zip_gap_expected']:.0f} "
                       f"in similar areas")
        b, sb = r["scenarios"]["base"], stress["scenarios"]["base"]
        pb = f"payback {b['payback_months']} months" if b["payback_months"] else f"payback {b['payback_note']}"
        out.append(f"Base case: {r['store']['sqft']} sqft, {r['store']['seats']} seats, profit ${b['monthly_profit']:,}/mo, {pb}")
        out.append(f"If traffic drops 30%: profit ${sb['monthly_profit']:,}/mo"
                   + (" (loss)" if sb["monthly_profit"] <= 0 else ""))
        if prices and prices["used_as_ticket"]:
            out.append(f"Ticket ${r['store']['suggested_ticket']} from {prices['n']} live menu-price observations")
        out.append(f"Customer fit {d['fit_ratio']}x city average for {cuisine}; income {d['income_vs_city']}x city median")
        if h["level"].startswith("city"):
            out.append(f"[info] 1,000-day license survival: too few local openings; citywide {h['rate']:.0%} (n={h['n']})")
        elif h["rate"] is not None:
            out.append(f"[info] 1,000-day license survival, {h['years']} openings here: {h['rate']:.0%} "
                       f"(n={h['n']}, {h['level']}; city {h['city_rate']:.0%}); model estimate "
                       f"{(nb['p_license_1000d'] if p_model is None else p_model):.0%}")
        return out

    # ---------------------------------------------------------------- map layers
    def map_geojson(self, result, path=None):
        """Neighborhood polygons with score, plus a citywide ZIP layer colored by supply-gap score."""
        cuisine = result["inputs"]["cuisine"]
        scores = {x["area"]: x["score"] for x in result["all_ranked"]}
        excl = {x["area"] for x in result["excluded"]}
        feats = []
        for f in self.geo["features"]:
            n = f["properties"]["name"]
            feats.append({"type": "Feature", "geometry": f["geometry"],
                          "properties": {"layer": "neighborhood", "name": n, "score": scores.get(n),
                                         "excluded_by_budget": n in excl}})
        zcai = (self.cai[self.cai.cuisine.isin(FIN_MAP[cuisine])]
                .assign(w=lambda d: d.expected + 1)
                .groupby("zip5").apply(lambda g: pd.Series({"gap_score": np.average(g.gap_score, weights=g.w),
                                                            "low_evidence": bool(g.low_evidence.all())}),
                                       include_groups=False))
        zg = json.loads((RAW / "zips" / "zips.geojson").read_text())
        for f in zg["features"]:
            zz = f["properties"]["zip"]
            row = zcai.loc[zz] if zz in zcai.index else None
            feats.append({"type": "Feature", "geometry": f["geometry"],
                          "properties": {"layer": "zip", "zip": zz,
                                         "gap_score": None if row is None else round(float(row.gap_score), 1),
                                         "low_evidence": None if row is None else bool(row.low_evidence)}})
        for n, b in self.area_boundary.items():
            if b == "zip":
                ring = self.polys[n].tolist()
                feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
                              "properties": {"layer": "neighborhood", "name": n, "score": scores.get(n),
                                             "excluded_by_budget": n in excl, "boundary": "zip"}})
        gj = {"type": "FeatureCollection", "features": feats}
        path = path or OUT / f"map_{cuisine}.geojson"
        path.write_text(json.dumps(gj))
        return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, required=True)
    ap.add_argument("--cuisine", required=True, choices=list(FIN_MAP))
    ap.add_argument("--space", default="new", choices=["new", "second_gen"])
    ap.add_argument("--traffic", type=float, default=1.0, help="traffic shock, e.g. 0.7 = -30%% covers")
    ap.add_argument("--food", type=float, default=1.0, help="food cost shock, e.g. 1.15 = +15%%")
    ap.add_argument("--json", action="store_true", help="print full JSON")
    ap.add_argument("--live", action="store_true", help="overlay live records from data/live/")
    a = ap.parse_args()
    from live import LiveStore
    eng = Engine(live=LiveStore() if a.live else None)
    res = eng.recommend(a.budget, a.cuisine, a.space, a.traffic, a.food)
    out = OUT / f"recommend_{a.cuisine}_{int(a.budget)}.json"
    out.write_text(json.dumps(res, indent=2, default=float))
    mp = eng.map_geojson(res)
    if a.json:
        print(json.dumps(res, indent=2, default=float))
        return
    print(f"{a.cuisine}, budget ${a.budget:,.0f}, {a.space}, traffic x{a.traffic}, food x{a.food}")
    for i, x in enumerate(res["top"], 1):
        sc = x["subscores"]
        print(f"\n{i}. {x['area']}  score {x['score']}  (gap {sc['supply_gap_pct']}, payback {sc['payback_pct']}, "
              f"traffic-30% {sc['traffic_-30%_profit_pct']})")
        for s in x["reasons"]:
            print("   -", s)
        for wmsg in x["risk"]["warnings"]:
            print("   ! ", wmsg)
        print("   space:", x["space_comparison"])
    for e in res["excluded"]:
        print(f"\nexcluded {e['area']}: {e['reason']}")
    print(f"\nsaved {out.name}, {mp.name}")


if __name__ == "__main__":
    main()
