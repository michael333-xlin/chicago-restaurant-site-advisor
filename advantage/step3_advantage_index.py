"""Step 3: Competitive Advantage Index (CAI) for every (cuisine, Chicago ZIP).

Component A - demand gap (Overture snapshot):
    For each cuisine c, a Poisson GLM predicts how many c-restaurants ZIP z "should" have given
    its total restaurant count (exposure) and demographics/jobs. Predictions are leave-one-ZIP-out,
    so a ZIP's own count never informs its expectation.
        gap_z = (expected - actual) / sqrt(expected + 1)      > 0  -> under-supplied
Component B - survival (license history, step 2 model):
    P(survive ~3 yrs) for a hypothetical new independent dine-in restaurant of cuisine c,
    opened today at typical restaurant locations inside z, with today's competition.
    Operator experience and address history are the averages of the ZIP's recent (2020-2022) independent
    openings (citywide average when the ZIP has fewer than MIN_DEFAULT_N); users can replace them with their own
    values through /api/survival. Sampled points and these defaults are saved for that endpoint.
CAI = 100 * (w * pct_rank(gap_z) + (1 - w) * pct_rank(P_surv)), ranked over all pairs,
    w = W_GAP * (leave-one-out correlation of the gap model for that cuisine, clipped to [0, 1]).
"""
import json
import pickle
import sys

import numpy as np
import pandas as pd

from common import CUISINES, FIN_MAP, FINANCE_DIR, NOW, OUT, SURVIVAL_DAYS, load_overture
from features import ADDRESS_FEATS, DATA_LAG, OPERATOR_FEATS, ZIP_FEATS, Competition, load_zip_panel, zip_year
from gapmodel import EXCLUDE_ZIPS, GAP_FEATS, gap_z, loo_expected, score_cai
from survival import hypothetical_frame, predict_calibrated

W_GAP = 0.5
MIN_REST_IN_ZIP = 30
PTS_PER_ZIP = 40
DEFAULT_YEARS = range(2020, 2023)   # recent openings whose 1,000-day label is known: source of the default inputs
MIN_DEFAULT_N = 10

ov = load_overture()
z = zip_year(load_zip_panel(), NOW.year - DATA_LAG)   # scoring today uses data year 2024
spans = pd.read_parquet(OUT / "license_spans.parquet")
train_tbl = pd.read_parquet(OUT / "survival_training_table.parquet")
bundle = pickle.load(open(OUT / "survival_model.pkl", "rb"))
FEATS = bundle["feats"]

chi = ov[ov.zip5.isin(z.index)]
counts = chi.groupby(["zip5", "cuisine"]).size().unstack(fill_value=0).reindex(columns=CUISINES, fill_value=0)
total = chi.groupby("zip5").size().rename("n_total")
zips = total[(total >= MIN_REST_IN_ZIP) & ~total.index.isin(EXCLUDE_ZIPS)].index
counts, total = counts.loc[zips], total.loc[zips]

# ---------------- A. demand gap ----------------
expected, gap_fit = loo_expected(counts, total, z.loc[zips, GAP_FEATS])
expected.columns.name = "cuisine"
gap = gap_z(expected, counts)

# ---------------- B. survival for a hypothetical new opening today ----------------
comp = Competition(spans)
# zip history: smoothed 1,000-day license survival of openings whose label is known by NOW
known = train_tbl[train_tbl.t + pd.Timedelta(days=SURVIVAL_DAYS) < NOW]
prior, K = known.survived.mean(), 20
zp = known.groupby("zip5").survived.agg(["sum", "size"])
zip_prior = ((zp["sum"] + K * prior) / (zp["size"] + K)).reindex(zips).fillna(prior)

# operator / address inputs for the hypothetical opening: averages of recent independent openings
PERSON = OPERATOR_FEATS + ADDRESS_FEATS
recent = train_tbl[train_tbl.year.isin(DEFAULT_YEARS) & (train_tbl.log_chain == 0)]
city_default = recent[PERSON].mean().to_dict()
zg = recent.groupby("zip5")[PERSON]
defaults = {zz: {"values": (zg.mean().loc[zz].to_dict() if zz in zg.groups and len(zg.groups[zz]) >= MIN_DEFAULT_N
                            else city_default),
                 "source": ("zip_average" if zz in zg.groups and len(zg.groups[zz]) >= MIN_DEFAULT_N else "city_average"),
                 "n": int(len(zg.groups.get(zz, [])))} for zz in zips}

rows, points = [], []
rng = np.random.default_rng(0)
for zz in zips:
    pts = chi[chi.zip5 == zz][["lat", "lon"]].values
    pts = pts[rng.choice(len(pts), min(PTS_PER_ZIP, len(pts)), replace=False)]
    local = comp.at(pts[:, 0], pts[:, 1], np.repeat(NOW.to_datetime64(), len(pts)))
    points.append(local.assign(zip5=zz, lat=pts[:, 0], lon=pts[:, 1]))
    zf = {f: z.at[zz, f] for f in ZIP_FEATS}
    for c in CUISINES:
        X = hypothetical_frame(local, c, zf, zip_prior[zz], defaults[zz]["values"])
        p = predict_calibrated(bundle, X)
        rows.append({"zip5": zz, "cuisine": c, "p_license_1000d": p.mean(),
                     "same_cuisine_within_500m": X.n_same_active.mean(),
                     "restaurants_within_500m": X.n_rest_active.mean()})
pd.concat(points, ignore_index=True).to_parquet(OUT / "survival_points.parquet")
json.dump({"as_of": str(NOW.date()), "default_years": [DEFAULT_YEARS[0], DEFAULT_YEARS[-1]], "min_n": MIN_DEFAULT_N,
           "features": PERSON, "city": city_default, "zip_prior": zip_prior.round(6).to_dict(), "zips": defaults},
          open(OUT / "survival_defaults.json", "w"), indent=1)
surv = pd.DataFrame(rows)

# ---------------- combine ----------------
out = surv.merge(counts.stack().rename("actual").reset_index(), on=["zip5", "cuisine"]) \
          .merge(expected.stack().rename("expected").reset_index(), on=["zip5", "cuisine"]) \
          .merge(gap.stack().rename("gap_z").reset_index(), on=["zip5", "cuisine"])
out["survival_lift_pp"] = 100 * (out.p_license_1000d - out.groupby("cuisine").p_license_1000d.transform("mean"))
# gap weight is scaled by how well the gap model reproduces that cuisine's real ZIP counts (LOO corr)
out["gap_reliability"] = out.cuisine.map(gap_fit).clip(0, 1)
# score_cai also flags low_evidence: model expects < 2 places, or the cuisine's gap model barely
# reproduces real ZIP counts (LOO corr < 0.4: chicken, chinese, south_asian, seafood, steakhouse, caribbean_african)
out = score_cai(out, W_GAP)
out = out.sort_values("CAI", ascending=False).round(4)
out.to_csv(OUT / "competitive_advantage_by_zip_cuisine.csv", index=False)

best_per_zip = out[~out.low_evidence].sort_values("CAI", ascending=False).groupby("zip5").head(3)
best_per_zip.sort_values(["zip5", "CAI"], ascending=[True, False]).to_csv(OUT / "top3_cuisines_per_zip.csv", index=False)
best_per_cuisine = out[~out.low_evidence].groupby("cuisine").head(3)
best_per_cuisine.to_csv(OUT / "top3_zips_per_cuisine.csv", index=False)
json.dump({"gap_model_loo_corr_by_cuisine": gap_fit, "n_zips_scored": len(zips)},
          open(OUT / "step3_report.json", "w"), indent=2)

# ---------------- C. hook into the team's finance model ----------------
sys.path.insert(0, str(FINANCE_DIR))
from finance import calc, load  # noqa: E402

params, rents = load("cuisine_params.json"), load("rent_by_area.json")
BUDGET = {"fast_food": 250_000, "italian": 500_000, "steakhouse": 1_200_000, "asian": 350_000}
fin_rows = []
for area, a in rents.items():
    zz = a["primary_zip"]
    for fc, groups in FIN_MAP.items():
        sub = out[(out.zip5 == zz) & out.cuisine.isin(groups)]
        if sub.empty:
            continue
        e, n = sub.expected.sum(), sub.actual.sum()
        p = float(np.average(sub.p_license_1000d, weights=sub.expected + 1))
        r2 = {k: dict(v) for k, v in rents.items()}
        r2[area]["demand_index"] = float(np.clip(np.sqrt((e + 1) / (n + 1)), 0.8, 1.2))  # replaces placeholder 1.0
        r = calc(BUDGET[fc], fc, area, params, r2)
        if not r["feasible"]:
            continue
        stress = calc(BUDGET[fc], fc, area, params, r2, traffic_shock=0.7)
        b = r["scenarios"]["base"]
        fin_rows.append({"area": area, "zip5": zz, "finance_cuisine": fc, "demand_index": round(r2[area]["demand_index"], 3),
                         "gap_score": round(float(np.average(sub.gap_score, weights=sub.expected + 1)), 1),
                         "payback_months_base": b["payback_months"], "monthly_profit_base": b["monthly_profit"],
                         "monthly_profit_traffic_-30%": stress["scenarios"]["base"]["monthly_profit"],
                         "capex": r["store"]["capex"],
                         "license_1000d_estimate": round(p, 3)})
fin = pd.DataFrame(fin_rows).sort_values("monthly_profit_traffic_-30%", ascending=False)
fin.to_csv(OUT / "finance_by_area.csv", index=False)

pd.set_option("display.width", 200)
cols = ["zip5", "cuisine", "gap_score", "CAI", "gap_z", "actual", "expected", "p_license_1000d"]
print("TOP 20 pairs\n", out[~out.low_evidence][cols].head(20).to_string(index=False))
print("\nBest zips per cuisine\n", best_per_cuisine[cols].to_string(index=False))
print("\nGap model LOO corr:", {k: round(v, 2) for k, v in gap_fit.items()})
print("\nFinance by area\n", fin.to_string(index=False))
