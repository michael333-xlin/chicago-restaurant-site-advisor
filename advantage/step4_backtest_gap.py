"""Step 4: backtest and stability of the supply gap ("similar-area cuisine supply baseline difference").

The gap is NOT a demand estimate. It says: compared with ZIPs that have a similar population, jobs and
income mix (and the same total number of restaurants), this ZIP has fewer / more places of this cuisine.

For each year Y in 2014-2022: supply snapshot on Jan 1 of Y from license records valid that day (unique
licenses, record location, out-of-fold cuisine probabilities), ZIP context of data year Y-2, the same
leave-one-ZIP-out Poisson model -> gap per (ZIP, cuisine). Then: do openings during Y in high-gap cells
reach the 1,000-day license mark more often?

Stability checks requested in review: per-year coefficient and quintiles, per-ZIP-group coefficients
(5 random ZIP groups and north/south), and whether the top quintile beats Q4 (monotonicity).
Writes output/step4_backtest_report.json; GAP_CAP (used for the gap score) is chosen here.
"""
import json

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

from common import CUISINES, NON_REST, OUT
from features import DATA_LAG, load_zip_panel, zip_year
from gapmodel import EXCLUDE_ZIPS, GAP_FEATS, gap_z, loo_expected
from snapshot import snapshot_id

sp = pd.read_parquet(OUT / "license_spans.parquet")
op = pd.read_parquet(OUT / "survival_training_table.parquet")
panel = load_zip_panel()
sp = sp[sp.zip5.isin(panel.zip5) & ~sp.zip5.isin(EXCLUDE_ZIPS)]

rows, fit_quality = [], {}
for Y in range(2014, 2023):
    t = pd.Timestamp(f"{Y}-01-01")
    z = zip_year(panel, Y - DATA_LAG)
    act = sp[(sp.start <= t) & (sp.end > t)].sort_values("start").drop_duplicates("license_number", keep="last")
    counts = act.groupby("zip5")[[f"p_{c}" for c in CUISINES]].sum()
    counts.columns = CUISINES
    total = (1 - act[f"p_{NON_REST}"]).groupby(act.zip5).sum()
    keep = total[total >= 30].index
    counts, total = counts.loc[keep], total.loc[keep]
    exp, corr = loo_expected(counts, total, z.loc[keep, GAP_FEATS])
    fit_quality[Y] = float(np.mean(list(corr.values())))
    g = gap_z(exp, counts).stack().rename("gap_z").reset_index().rename(columns={"level_1": "cuisine"})
    o = op[(op.year == Y) & op.cuisine.isin(CUISINES)].merge(g, on=["zip5", "cuisine"])
    rows.append(o[["year", "zip5", "cuisine", "survived", "gap_z", "log_chain", "lat"]])

bt = pd.concat(rows, ignore_index=True)
Q = ["Q1 most over-supplied", "Q2", "Q3", "Q4", "Q5 most under-supplied"]
bt["gap_q"] = pd.qcut(bt.gap_z, 5, labels=Q)
edges = bt.gap_z.quantile([0.2, 0.4, 0.6, 0.8]).round(3).tolist()


def coef(df, formula="survived ~ gap_z + C(cuisine) + C(year) + log_chain"):
    df = df.copy()
    rare = df.cuisine.map(df.cuisine.value_counts()) < 40     # sparse cuisines -> one bucket (avoids separation)
    df.loc[rare, "cuisine"] = "other"
    try:
        f = smf.logit(formula, data=df).fit(disp=0)
        return {"coef": float(f.params["gap_z"]), "p": float(f.pvalues["gap_z"]), "n": int(len(df))}
    except Exception as e:  # noqa: BLE001 - small groups can be separable
        return {"error": str(e)[:80], "n": int(len(df))}


res = {"snapshot_id": snapshot_id(), "n": len(bt), "quintile_edges_gap_z": edges,
       "gap_model_mean_loo_corr_by_year": fit_quality,
       "survival_by_gap_quintile": bt.groupby("gap_q", observed=True).survived.agg(["mean", "size"]).round(3).to_dict("index"),
       "pooled_controlled": coef(bt),
       "pooled_raw": coef(bt, "survived ~ gap_z")}

# per year
py = {}
for Y, g in bt.groupby("year"):
    qs = g.groupby("gap_q", observed=True).survived.mean()
    py[int(Y)] = {**coef(g, "survived ~ gap_z + C(cuisine) + log_chain"),
                  "q1": float(qs.get(Q[0], np.nan)), "q4": float(qs.get(Q[3], np.nan)), "q5": float(qs.get(Q[4], np.nan))}
res["per_year"] = py
yr = pd.DataFrame(py).T
res["per_year_summary"] = {"share_positive_coef": float((yr.coef > 0).mean()),
                           "share_q5_above_q1": float((yr.q5 > yr.q1).mean()),
                           "share_q5_above_q4": float((yr.q5 > yr.q4).mean())}

# per ZIP group
zips = np.array(sorted(bt.zip5.unique()))
grp = dict(zip(zips, np.random.default_rng(0).permutation(len(zips)) % 5))
bt["zip_group"] = bt.zip5.map(grp)
res["per_zip_group"] = {int(k): coef(g) for k, g in bt.groupby("zip_group")}
med_lat = bt.groupby("zip5").lat.mean().median()
bt["north"] = bt.zip5.map(bt.groupby("zip5").lat.mean() > med_lat)
res["north_vs_south"] = {("north" if k else "south"): coef(g) for k, g in bt.groupby("north")}

# cap: if the top quintile is not reliably better than Q4, stop rewarding gap beyond the Q4/Q5 edge
q4_vs_q5 = res["per_year_summary"]["share_q5_above_q4"]
res["gap_cap"] = edges[3] if q4_vs_q5 < 0.7 else None
res["gap_cap_rule"] = ("gap_z capped at the Q4/Q5 edge because Q5 beat Q4 in fewer than 70% of years"
                       if res["gap_cap"] is not None else "no cap: Q5 beat Q4 in >= 70% of years")

bt.to_csv(OUT / "backtest_gap_openings.csv", index=False)
# compatibility key for the retrain guardrail
res["logit_gap_p_controlled"] = res["pooled_controlled"].get("p")
json.dump(res, open(OUT / "step4_backtest_report.json", "w"), indent=2)
print(json.dumps({k: res[k] for k in ["n", "survival_by_gap_quintile", "pooled_controlled", "pooled_raw",
                                      "per_year_summary", "gap_cap", "gap_cap_rule"]}, indent=2))
print(pd.DataFrame(py).T.round(3).to_string())
print("zip groups:", {k: (round(v.get("coef", np.nan), 3), round(v.get("p", np.nan), 3)) for k, v in res["per_zip_group"].items()})
print("north/south:", {k: (round(v.get("coef", np.nan), 3), round(v.get("p", np.nan), 3)) for k, v in res["north_vs_south"].items()})
