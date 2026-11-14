"""Step 4: does the demand-gap signal actually predict survival? (historical backtest)

For each year Y in 2014-2022: take a supply snapshot on Jan 1 of Y from licenses active that day
(cuisine = classifier probabilities), fit the same leave-one-ZIP-out Poisson gap model, then look at
restaurants that OPENED during Y and whether they survived ~3 years. Only information available on
Jan 1 of Y goes into the gap, so this is an honest out-of-time test of the gap component.
"""
import json

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

from common import CUISINES, NON_REST, OUT
from features import DATA_LAG, load_zip_panel, zip_year
from gapmodel import EXCLUDE_ZIPS, GAP_FEATS, gap_z, loo_expected

lic = pd.read_parquet(OUT / "licenses_with_cuisine.parquet")
op = pd.read_parquet(OUT / "survival_training_table.parquet")
panel = load_zip_panel()
lic = lic[lic.zip5.isin(panel.zip5) & ~lic.zip5.isin(EXCLUDE_ZIPS)]

rows = []
for Y in range(2014, 2023):
    t = pd.Timestamp(f"{Y}-01-01")
    z = zip_year(panel, Y - DATA_LAG)        # only data published by Jan 1 of Y
    act = lic[(lic.start <= t) & (lic.end > t)]
    counts = act.groupby("zip5")[[f"p_{c}" for c in CUISINES]].sum()
    counts.columns = CUISINES
    total = (1 - act[f"p_{NON_REST}"]).groupby(act.zip5).sum()
    keep = total[total >= 30].index
    counts, total = counts.loc[keep], total.loc[keep]
    exp, corr = loo_expected(counts, total, z.loc[keep, GAP_FEATS])
    g = gap_z(exp, counts).stack().rename("gap_z").reset_index().rename(columns={"level_1": "cuisine"})
    o = op[(op.year == Y) & op.cuisine.isin(CUISINES)].merge(g, on=["zip5", "cuisine"])
    rows.append(o[["year", "zip5", "cuisine", "survived", "gap_z", "n_same_active", "log_chain"]])
    print(Y, "openings matched:", len(o), " mean LOO corr:", round(np.mean(list(corr.values())), 2))

bt = pd.concat(rows, ignore_index=True)
bt["gap_q"] = pd.qcut(bt.gap_z, 5, labels=["Q1 most over-supplied", "Q2", "Q3", "Q4", "Q5 most under-supplied"])
by_q = bt.groupby("gap_q", observed=True).survived.agg(["mean", "size"]).round(3)

fit = smf.logit("survived ~ gap_z + C(cuisine) + C(year) + log_chain", data=bt).fit(disp=0)
fit_raw = smf.logit("survived ~ gap_z", data=bt).fit(disp=0)
res = {
    "n": len(bt),
    "survival_by_gap_quintile": by_q.to_dict("index"),
    "logit_gap_coef_controlled": float(fit.params["gap_z"]), "logit_gap_p_controlled": float(fit.pvalues["gap_z"]),
    "logit_gap_coef_raw": float(fit_raw.params["gap_z"]), "logit_gap_p_raw": float(fit_raw.pvalues["gap_z"]),
}
bt.to_csv(OUT / "backtest_gap_openings.csv", index=False)
json.dump(res, open(OUT / "step4_backtest_report.json", "w"), indent=2)
print(by_q.to_string())
print(json.dumps({k: v for k, v in res.items() if k.startswith("logit")}, indent=2))
