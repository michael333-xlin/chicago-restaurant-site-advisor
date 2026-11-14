"""Step 1: learn  business name -> cuisine group  from Overture, apply to every license.

Why: the license table has no cuisine field, and Overture only lists restaurants that are
open today. To get cuisine for restaurants that already closed (needed for survival labels)
we train a text classifier on Overture names and apply the SAME classifier to every license,
open or closed, so the cuisine label is not correlated with the outcome.
"""
import numpy as np
import pandas as pd
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

from common import CUISINES, NON_REST, OUT, load_license_records, load_overture, norm_name

ov = load_overture()
L = load_license_records()

# One row per license_number: lifetime span, latest name/location, activity.
L = L.sort_values("license_start_date")
lic = L.groupby("license_number").agg(
    start=("license_start_date", "min"), end=("expiration_date", "max"),
    first_issue=("date_issued", "min"),
    name=("doing_business_as_name", "last"), legal=("legal_name", "last"),
    lat=("lat", "last"), lon=("lon", "last"), zip5=("zip5", "last"),
    community_area=("community_area", "last"),
    activity=("business_activity", lambda s: " | ".join(sorted(set(s.dropna())))),
    has_issue=("application_type", lambda s: (s == "ISSUE").any()),
).reset_index()
lic["name_norm"] = lic.name.map(norm_name)
lic["is_dining"] = lic.activity.str.contains("Dining|Prepared Onsite", na=False)
specific = lic.activity.str.len() > 0
lic["is_nonrest"] = specific & ~lic.is_dining & ~lic.activity.eq("Retail Sales of Perishable Foods")

# Training set: Overture names with a cuisine + license names that are clearly not restaurants.
pos = ov.dropna(subset=["cuisine"])[["name_norm", "cuisine"]].rename(columns={"cuisine": "y"})
neg = lic[lic.is_nonrest][["name_norm"]].assign(y=NON_REST)
train = pd.concat([pos, neg]).query("name_norm != ''").reset_index(drop=True)

v_char = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True)
v_word = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=1, sublinear_tf=True)


def fit(names, y):
    X = hstack([v_char.fit_transform(names), v_word.fit_transform(names)]).tocsr()
    return LogisticRegression(C=8, max_iter=3000).fit(X, y)


def transform(names):
    return hstack([v_char.transform(names), v_word.transform(names)]).tocsr()


# --- evaluation on a held-out 20% ---
tr, te = train_test_split(train, test_size=0.2, random_state=0, stratify=train.y)
clf = fit(tr.name_norm, tr.y)
P = clf.predict_proba(transform(te.name_norm))
pred = clf.classes_[P.argmax(1)]
conf = P.max(1)
rest_te = te.y != NON_REST
report = {
    "holdout_accuracy_all": float((pred == te.y).mean()),
    "holdout_accuracy_cuisine_only": float((pred[rest_te] == te.y[rest_te]).mean()),
    "majority_baseline_cuisine_only": float(te.y[rest_te].value_counts(normalize=True).iloc[0]),
}
for t in [0.5, 0.7]:
    m = rest_te.values & (conf >= t)
    report[f"precision_at_conf>={t}"] = float((pred[m] == te.y.values[m]).mean())
    report[f"coverage_at_conf>={t}"] = float(m.sum() / rest_te.sum())

# --- external check: license names that exactly match an Overture name in the same zip ---
key = ov.dropna(subset=["cuisine"]).drop_duplicates(["name_norm", "zip5"]).set_index(["name_norm", "zip5"]).cuisine
lic["overture_cuisine"] = [key.get((n, z)) for n, z in zip(lic.name_norm, lic.zip5)]

# --- final model on all data, applied to every license ---
clf = fit(train.name_norm, train.y)
import pickle  # noqa: E402
pickle.dump({"v_char": v_char, "v_word": v_word, "clf": clf}, open(OUT / "cuisine_classifier.pkl", "wb"))
P = pd.DataFrame(clf.predict_proba(transform(lic.name_norm.fillna(""))), columns=clf.classes_)
lic = pd.concat([lic.reset_index(drop=True), P.add_prefix("p_")], axis=1)
lic["pred"] = P.idxmax(axis=1).values
lic["pred_conf"] = P.max(axis=1).values
m = lic.overture_cuisine.notna()
report["license_vs_overture_match_n"] = int(m.sum())
report["license_vs_overture_accuracy"] = float((lic.pred[m] == lic.overture_cuisine[m]).mean())

pd.Series(report).to_json(OUT / "step1_classifier_report.json", indent=2)
lic.to_parquet(OUT / "licenses_with_cuisine.parquet")
print(pd.Series(report).round(3).to_string())
print(lic[lic.is_dining].pred.value_counts().head(20).to_string())
