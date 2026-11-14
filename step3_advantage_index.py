"""Step 3: Competitive Advantage Index (CAI) for every (cuisine, Chicago ZIP).

Component A - demand gap (Overture snapshot):
    For each cuisine c, a Poisson GLM predicts how many c-restaurants ZIP z "should" have given
    its total restaurant count (exposure) and demographics/jobs. Predictions are leave-one-ZIP-out,
    so a ZIP's own count never informs its expectation.
        gap_z = (expected - actual) / sqrt(expected + 1)      > 0  -> under-supplied
Component B - survival (license history, step 2 model):
    P(survive ~3 yrs) for a hypothetical new independent dine-in restaurant of cuisine c,
    opened today at typical restaurant locations inside z, with today's competition.
CAI = 100 * (w * pct_rank(gap_z) + (1 - w) * pct_rank(P_surv)), ranked over all pairs,
    w = W_GAP * (leave-one-out correlation of the gap model for that cuisine, clipped to [0, 1]).
"""
import json
import pickle
import sys

import numpy as np
import pandas as pd

from common import CUISINES, FIN_MAP, FINANCE_DIR, NOW, OUT, SURVIVAL_DAYS, load_overture
from features import DATA_LAG, LOCAL_FEATS, ZIP_FEATS, Competition, load_zip_panel, same_cuisine_columns, zip_year
from gapmodel import EXCLUDE_ZIPS, GAP_FEATS, gap_z, loo_expected, score_cai

W_GAP = 0.5
MIN_REST_IN_ZIP = 30
PTS_PER_ZIP = 40

ov = load_overture()
z = zip_year(load_zip_panel(), NOW.year - DATA_LAG)   # scoring today uses data year 2024
lic = pd.read_parquet(OUT / "licenses_with_cuisine.parquet")
train_tbl = pd.read_parquet(OUT / "survival_training_table.parquet")
bundle = pickle.load(open(OUT / "survival_model.pkl", "rb"))
model, FEATS = bundle["model"], bundle["feats"]

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
comp = Competition(lic)
# zip history: smoothed survival of all openings whose 3-yr outcome is known by NOW
known = train_tbl[train_tbl.t + pd.Timedelta(days=SURVIVAL_DAYS) < NOW]
prior, K = known.survived.mean(), 20
zp = known.groupby("zip5").survived.agg(["sum", "size"])
zip_prior = ((zp["sum"] + K * prior) / (zp["size"] + K)).reindex(zips).fillna(prior)

rows = []
rng = np.random.default_rng(0)
for zz in zips:
    pts = chi[chi.zip5 == zz][["lat", "lon"]].values
    pts = pts[rng.choice(len(pts), min(PTS_PER_ZIP, len(pts)), replace=False)]
    local = comp.at(pts[:, 0], pts[:, 1], np.repeat(NOW.to_datetime64(), len(pts)))
    for c in CUISINES:
        X = pd.concat([local, same_cuisine_columns(local, [c] * len(pts))], axis=1)
        X["cuisine"], X["format"], X["log_chain"], X["zip_prior_surv"] = c, "dine_in", 0.0, zip_prior[zz]
        for f in ZIP_FEATS:
            X[f] = z.at[zz, f]
        Xm = X[FEATS].copy()
        Xm["cuisine"] = pd.Categorical(Xm.cuisine, categories=CUISINES + ["unknown"]).codes
        Xm["format"] = pd.Categorical(Xm.format, categories=["dine_in", "takeout", "other"]).codes
        p = model.predict_proba(Xm)[:, 1]
        rows.append({"zip5": zz, "cuisine": c, "p_survive_3y": p.mean(),
                     "same_cuisine_within_500m": X.n_same_active.mean(),
                     "restaurants_within_500m": X.n_rest_active.mean()})
surv = pd.DataFrame(rows)

# ---------------- combine ----------------
out = surv.merge(counts.stack().rename("actual").reset_index(), on=["zip5", "cuisine"]) \
          .merge(expected.stack().rename("expected").reset_index(), on=["zip5", "cuisine"]) \
          .merge(gap.stack().rename("gap_z").reset_index(), on=["zip5", "cuisine"])
out["survival_lift_pp"] = 100 * (out.p_survive_3y - out.groupby("cuisine").p_survive_3y.transform("mean"))
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
        p = float(np.average(sub.p_survive_3y, weights=sub.expected + 1))
        r2 = {k: dict(v) for k, v in rents.items()}
        r2[area]["demand_index"] = float(np.clip(np.sqrt((e + 1) / (n + 1)), 0.8, 1.2))  # replaces placeholder 1.0
        r = calc(BUDGET[fc], fc, area, params, r2)
        if not r["feasible"]:
            continue
        mp, capex = r["scenarios"]["base"]["monthly_profit"], r["store"]["capex"]
        s_m = p ** (1 / 36)                                   # constant monthly survival implied by 3-yr P
        exp_months_5y = float(sum(s_m ** m for m in range(1, 61)))
        payback = capex / mp if mp > 0 else np.inf
        fin_rows.append({"area": area, "zip5": zz, "finance_cuisine": fc, "demand_index": round(r2[area]["demand_index"], 3),
                         "p_survive_3y": round(p, 3), "monthly_profit_base": mp, "capex": capex,
                         "payback_months": round(payback, 1) if np.isfinite(payback) else None,
                         "p_reach_payback": round(s_m ** payback, 3) if np.isfinite(payback) else 0.0,
                         "risk_adj_5y_value": round(mp * exp_months_5y - capex),
                         "CAI_mean": round(sub.CAI.mean(), 1)})
fin = pd.DataFrame(fin_rows).sort_values("risk_adj_5y_value", ascending=False)
fin.to_csv(OUT / "finance_risk_adjusted.csv", index=False)

pd.set_option("display.width", 200)
cols = ["zip5", "cuisine", "CAI", "gap_z", "actual", "expected", "p_survive_3y", "survival_lift_pp"]
print("TOP 20 pairs\n", out[~out.low_evidence][cols].head(20).to_string(index=False))
print("\nBest zips per cuisine\n", best_per_cuisine[cols].to_string(index=False))
print("\nGap model LOO corr:", {k: round(v, 2) for k, v in gap_fit.items()})
print("\nFinance x risk\n", fin.to_string(index=False))
