"""Step 2: survival model.  P(restaurant still licensed after ~3 years | cuisine, location, time).

Sample: every first-issue Retail Food license with a dining / prepared-onsite activity,
opened 2013-2022 (so every opening has a complete 3-year window).
Label:  survived = license lifetime >= SURVIVAL_DAYS (i.e. renewed at least once).
Validation: temporal split, train on 2013-2018 openings, test on 2019-2022.
"""
import json
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.compose import make_column_transformer
from sklearn.impute import SimpleImputer

from common import COHORT_YEARS, CUISINES, OUT, SURVIVAL_DAYS, load_license_records
from features import DATA_LAG, LOCAL_FEATS, ZIP_FEATS, Competition, same_cuisine_columns, zip_panel

lic = pd.read_parquet(OUT / "licenses_with_cuisine.parquet")
records = load_license_records()
issue = records[(records.application_type == "ISSUE")
                & records.business_activity.str.contains("Dining|Prepared Onsite", na=False)]
op = (issue.sort_values("license_start_date").drop_duplicates("license_number")
      [["license_number", "license_start_date", "lat", "lon", "zip5", "business_activity"]]
      .merge(lic[["license_number", "end", "pred", "pred_conf"]], on="license_number"))
op = op.rename(columns={"license_start_date": "t"}).dropna(subset=["t", "lat", "lon"])
op = op[op.t.dt.year.isin(COHORT_YEARS)].reset_index(drop=True)
op["survived"] = ((op.end - op.t).dt.days >= SURVIVAL_DAYS).astype(int)
# cuisine used by the model: confident classifier label, otherwise "unknown"
op["cuisine"] = np.where((op.pred_conf >= 0.5) & op.pred.isin(CUISINES), op.pred, "unknown")
op["year"] = op.t.dt.year
op["format"] = np.select(
    [op.business_activity.str.contains("Without Dining", na=False),
     op.business_activity.str.contains("With Seating|With Dining", na=False)],
    ["takeout", "dine_in"], "other")

# chain signal: how many OTHER licenses with the same name already existed before t
nm = lic[["license_number", "name_norm", "start"]].dropna()
op = op.merge(lic[["license_number", "name_norm"]], on="license_number", how="left")
first = nm.groupby("name_norm").start.apply(lambda s: np.sort(s.values.astype("datetime64[D]")))
op["log_chain"] = np.log1p([
    np.searchsorted(first.get(n, np.array([], "datetime64[D]")), t.to_datetime64().astype("datetime64[D]"))
    if isinstance(n, str) and len(n) > 2 else 0 for n, t in zip(op.name_norm, op.t)])

# history known at t: survival of earlier openings in the same zip whose 3-year outcome was observable by t
op = op.sort_values("t").reset_index(drop=True)
CITY_PRIOR, K = op.survived.mean(), 20
known_t = op.t + pd.Timedelta(days=SURVIVAL_DAYS)
zip_prior = np.empty(len(op))
for z5, g in op.groupby("zip5"):
    kt, sv = known_t[g.index].values, g.survived.values
    order = np.argsort(kt); kt, cs = kt[order], np.cumsum(sv[order])
    n = np.searchsorted(kt, g.t.values)          # outcomes known strictly before t
    s_ = np.where(n > 0, cs[np.maximum(n - 1, 0)], 0)
    zip_prior[g.index] = (s_ + K * CITY_PRIOR) / (n + K)
op["zip_prior_surv"] = zip_prior

comp = Competition(lic)
local = comp.at(op.lat.values, op.lon.values, op.t.values, exclude=op.license_number.values)
op = pd.concat([op, local, same_cuisine_columns(local, op.cuisine)], axis=1)
# point-in-time ZIP context: an opening in year Y only sees data year Y - DATA_LAG
panel = zip_panel(lic)
op["data_year"] = op.year - DATA_LAG
op = op.merge(panel[["zip5", "data_year", "pop_year_used"] + ZIP_FEATS], on=["zip5", "data_year"], how="left")
op.to_parquet(OUT / "survival_training_table.parquet")

FEATS = ["cuisine", "format", "log_chain", "zip_prior_surv"] + LOCAL_FEATS + ZIP_FEATS
NUM = FEATS[2:]


def gbm():
    return HistGradientBoostingClassifier(
        categorical_features=[0, 1], max_iter=150, learning_rate=0.03, max_leaf_nodes=7,
        min_samples_leaf=100, l2_regularization=1.0, random_state=0)


def as_X(df):
    X = df[FEATS].copy()
    X["cuisine"] = pd.Categorical(X.cuisine, categories=CUISINES + ["unknown"]).codes
    X["format"] = pd.Categorical(X.format, categories=["dine_in", "takeout", "other"]).codes
    return X


def logit():
    pre = make_column_transformer(
        (OneHotEncoder(handle_unknown="ignore"), ["cuisine", "format"]),
        (make_pipeline(SimpleImputer(strategy="median"), StandardScaler()), NUM))
    return make_pipeline(pre, LogisticRegression(C=0.5, max_iter=2000))


train, test = op[op.year <= 2018], op[op.year >= 2019]
res = {"n_openings": len(op),
       "share_rows_pop_from_later_year": float((op.pop_year_used > op.data_year).mean()), "survival_rate": float(op.survived.mean()),
       "n_train_2013_2018": len(train), "n_test_2019_2022": len(test)}
m_g = gbm().fit(as_X(train), train.survived)
m_l = logit().fit(train[FEATS], train.survived)
pg, pl = m_g.predict_proba(as_X(test))[:, 1], m_l.predict_proba(test[FEATS])[:, 1]
base = np.full(len(test), train.survived.mean())
res.update({
    "auc_gbm": roc_auc_score(test.survived, pg), "auc_logit": roc_auc_score(test.survived, pl),
    "brier_gbm": brier_score_loss(test.survived, pg), "brier_logit": brier_score_loss(test.survived, pl),
    "brier_constant": brier_score_loss(test.survived, base),
})
imp = permutation_importance(m_g, as_X(test), test.survived, scoring="roc_auc", n_repeats=5, random_state=0)
res["permutation_importance_auc"] = dict(sorted(zip(FEATS, imp.importances_mean.round(4)), key=lambda x: -x[1]))
res["survival_by_cuisine"] = op.groupby("cuisine").survived.agg(["mean", "size"]).round(3).to_dict("index")

# Final model on all cohorts, saved for scoring
final = gbm().fit(as_X(op), op.survived)
pickle.dump({"model": final, "feats": FEATS}, open(OUT / "survival_model.pkl", "wb"))
json.dump(res, open(OUT / "step2_survival_report.json", "w"), indent=2, default=float)
print(json.dumps(res, indent=2, default=float))
