"""Step 1: business name -> cuisine group, trained on Overture names, applied to every license RECORD.

Leakage controls
  * Grouped by normalized name: a name (e.g. a chain) is never in both train and test, and every license
    name is predicted by a fold model that never saw that exact name (out-of-fold). Without this, names of
    restaurants that are still open (they are in Overture) get confident predictions while closed ones do
    not, so "cuisine known vs unknown" would leak the survival outcome.
  * Point in time: each license record keeps the name and location it had on that record, instead of the
    license's latest name/address.

Outputs
  output/license_spans.parquet        one row per license record: span, location, name, account, legal name,
                                      OOF cuisine probs
  output/cuisine_classifier.pkl       model fit on all names (only for NEW names arriving via live data)
  output/step1_classifier_report.json grouped-CV metrics overall and per cuisine, transfer check
  output/step1_closed_sample.csv      closed historical openings with predictions, for manual review
"""
import hashlib
import json
import pickle

import numpy as np
import pandas as pd
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from common import COHORT_YEARS, CUISINES, NON_REST, OUT, SURVIVAL_DAYS, load_license_records, load_overture, norm_name
from snapshot import snapshot_id

K = 5
CONF = 0.5


def fold_of(name):
    return int(hashlib.md5(name.encode()).hexdigest(), 16) % K


class NameModel:
    def __init__(self):
        self.vc = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True)
        self.vw = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=1, sublinear_tf=True)

    def fit(self, names, y):
        X = hstack([self.vc.fit_transform(names), self.vw.fit_transform(names)]).tocsr()
        self.clf = LogisticRegression(C=8, max_iter=3000).fit(X, y)
        return self

    def proba(self, names):
        X = hstack([self.vc.transform(names), self.vw.transform(names)]).tocsr()
        return pd.DataFrame(self.clf.predict_proba(X), columns=self.clf.classes_)


ov = load_overture()
R = load_license_records()
R["name_norm"] = R.doing_business_as_name.map(norm_name)
R["start"] = R.license_start_date.fillna(R.date_issued)
R["end"] = R.expiration_date
R = R.dropna(subset=["start", "end"]).reset_index(drop=True)

# negatives: names on records whose activity is specific and clearly not a restaurant
act = R.business_activity.fillna("")
nonrest = (act.str.len() > 0) & ~act.str.contains("Dining|Prepared Onsite") & (act != "Retail Sales of Perishable Foods")
pos = ov.dropna(subset=["cuisine"])[["name_norm", "cuisine"]].rename(columns={"cuisine": "y"})
neg = R[nonrest][["name_norm"]].assign(y=NON_REST)
train = pd.concat([pos, neg]).query("name_norm != ''")
# one label per name: the most common one (a chain name can appear many times)
train = train.groupby("name_norm").y.agg(lambda s: s.value_counts().index[0]).reset_index()
train["fold"] = train.name_norm.map(fold_of)

# ---- grouped CV: out-of-fold predictions on the training names
models, oof = {}, []
for k in range(K):
    tr, te = train[train.fold != k], train[train.fold == k]
    models[k] = NameModel().fit(tr.name_norm, tr.y)
    p = models[k].proba(te.name_norm)
    p.index = te.index
    oof.append(p)
oof = pd.concat(oof).reindex(train.index).fillna(0)
classes = list(models[0].clf.classes_)
pred, conf = oof[classes].idxmax(axis=1), oof[classes].max(axis=1)
is_c = train.y != NON_REST
rep = {"snapshot_id": snapshot_id(), "split": f"GroupKFold by normalized name, K={K}",
       "n_train_names": int(len(train)),
       "accuracy_all": float((pred == train.y).mean()),
       "accuracy_cuisine_only": float((pred[is_c] == train.y[is_c]).mean()),
       "majority_baseline_cuisine_only": float(train.y[is_c].value_counts(normalize=True).iloc[0]),
       f"precision_conf>={CONF}": float((pred[is_c & (conf >= CONF)] == train.y[is_c & (conf >= CONF)]).mean()),
       f"coverage_conf>={CONF}": float((is_c & (conf >= CONF)).sum() / is_c.sum())}
per = {}
for c in CUISINES + [NON_REST]:
    m, mp = train.y == c, pred == c
    hc = m & (conf >= CONF)
    per[c] = {"n": int(m.sum()), "recall": float((mp & m).sum() / max(m.sum(), 1)),
              "precision": float((mp & m).sum() / max(mp.sum(), 1)),
              f"coverage_conf>={CONF}": float(hc.sum() / max(m.sum(), 1)),
              f"precision_conf>={CONF}": float((pred[hc] == c).mean()) if hc.any() else None}
rep["per_class"] = per

# ---- OOF predictions for every distinct license name (each by the model that never saw it)
names = pd.DataFrame({"name_norm": R.name_norm.unique()})
names["fold"] = names.name_norm.map(fold_of)
parts = []
for k in range(K):
    sub = names[names.fold == k]
    p = models[k].proba(sub.name_norm.fillna(""))
    p.index = sub.index
    parts.append(p)
P = pd.concat(parts).reindex(names.index)[classes]
names = pd.concat([names, P.add_prefix("p_")], axis=1)

# ---- spans table (record level, point in time)
spans = R[["license_number", "account_number", "legal_name", "application_type", "start", "end", "date_issued",
           "lat", "lon", "zip5", "community_area", "name_norm", "address", "business_activity"]].merge(
    names.drop(columns="fold"), on="name_norm", how="left")
spans.to_parquet(OUT / "license_spans.parquet")

# ---- transfer check: survivors vs closed openings should look alike to the classifier
full = NameModel().fit(train.name_norm, train.y)
pickle.dump({"v_char": full.vc, "v_word": full.vw, "clf": full.clf}, open(OUT / "cuisine_classifier.pkl", "wb"))
iss = spans[(spans.application_type == "ISSUE") & spans.business_activity.str.contains("Dining|Prepared Onsite", na=False)]
iss = iss.sort_values("start").drop_duplicates("license_number")
iss = iss[iss.start.dt.year.isin(COHORT_YEARS)]
life = R.groupby("license_number").end.max()
iss = iss.assign(survived=((iss.license_number.map(life) - iss.start).dt.days >= SURVIVAL_DAYS))
pc = [f"p_{c}" for c in classes]
iss["oof_conf"] = iss[pc].max(axis=1)
iss["oof_known"] = (iss.oof_conf >= CONF) & ~iss[pc].idxmax(axis=1).eq(f"p_{NON_REST}")
insample = full.proba(iss.name_norm.fillna(""))
iss["insample_known"] = ((insample.max(axis=1) >= CONF) & insample.idxmax(axis=1).ne(NON_REST)).values
iss["in_overture"] = iss.name_norm.isin(set(ov.name_norm))
tc = iss.groupby("survived")[["oof_known", "insample_known", "in_overture"]].mean().round(3)
rep["transfer_check"] = {
    "share_confident_cuisine_by_outcome_OOF": tc.oof_known.to_dict(),
    "share_confident_cuisine_by_outcome_insample_OLD": tc.insample_known.to_dict(),
    "share_name_in_overture_by_outcome": tc.in_overture.to_dict(),
    "note": "keys: survived False/True. A gap between False and True = cuisine availability depends on the outcome.",
}
rng = np.random.default_rng(0)
closed = iss[~iss.survived]
smp = closed.iloc[rng.choice(len(closed), 60, replace=False)].copy()
smp["pred"] = smp[pc].idxmax(axis=1).str[2:]
smp[["license_number", "start", "name_norm", "address", "business_activity", "pred", "oof_conf"]] \
    .to_csv(OUT / "step1_closed_sample.csv", index=False)

json.dump(rep, open(OUT / "step1_classifier_report.json", "w"), indent=2)
print(json.dumps({k: v for k, v in rep.items() if k != "per_class"}, indent=2))
print(pd.DataFrame(per).T.round(3).to_string())
