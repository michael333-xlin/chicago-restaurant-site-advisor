"""Survival-model definitions shared by training (step2), scoring (step3) and the audit.

Target: "1,000-day license survival" = the license of a new restaurant is still valid ~1,000 days after it
started (in practice: the first 2-year license was renewed at least once). See step2b_label_audit.py for
how well this matches actual operation.
"""
import numpy as np
import pandas as pd
from sklearn.compose import make_column_transformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from common import CUISINES
from features import ADDRESS_FEATS, LOCAL_FEATS, OPERATOR_FEATS, ZIP_FEATS

CAT = ["cuisine", "format"]
FEATURE_GROUPS = {
    "cuisine_format": ["cuisine", "format"],
    "chain": ["log_chain"],
    "local_competition": LOCAL_FEATS,
    "zip_context": ZIP_FEATS,
    "zip_history": ["zip_prior_surv"],
    "operator": OPERATOR_FEATS,           # earlier licenses of the same account, company vs person (features.py)
    "address_history": ADDRESS_FEATS,     # food licenses that ended at the same address in the last 5 years
}
ALL = [f for g in FEATURE_GROUPS.values() for f in g]
CATEGORIES = {"cuisine": CUISINES + ["unknown"], "format": ["dine_in", "takeout", "other"]}


def feature_set(drop=()):
    return [f for g, fs in FEATURE_GROUPS.items() if g not in drop for f in fs]


class Constant:
    def fit(self, X, y):
        self.p = float(np.mean(y))
        return self

    def predict_proba(self, X):
        return np.c_[np.full(len(X), 1 - self.p), np.full(len(X), self.p)]


class GBM:
    def __init__(self, feats):
        self.feats = feats
        cat_idx = [i for i, f in enumerate(feats) if f in CAT]
        self.m = HistGradientBoostingClassifier(
            categorical_features=cat_idx or None, max_iter=150, learning_rate=0.03, max_leaf_nodes=7,
            min_samples_leaf=100, l2_regularization=1.0, random_state=0)

    def _X(self, df):
        X = df[self.use].copy()
        for c in CAT:
            if c in X:
                X[c] = pd.Categorical(X[c], categories=CATEGORIES[c]).codes
        return X

    def fit(self, df, y):
        # features with no data in this training window (e.g. population before 2018) are dropped
        self.use = [f for f in self.feats if df[f].notna().any()]
        self.m.set_params(categorical_features=[i for i, f in enumerate(self.use) if f in CAT] or None)
        self.m.fit(self._X(df), y)
        return self

    def predict_proba(self, df):
        return self.m.predict_proba(self._X(df))


class Logit:
    def __init__(self, feats):
        self.feats = feats
        cats = [f for f in feats if f in CAT]
        nums = [f for f in feats if f not in CAT]
        parts = []
        if cats:
            parts.append((OneHotEncoder(handle_unknown="ignore"), cats))
        if nums:
            parts.append((make_pipeline(SimpleImputer(strategy="median", keep_empty_features=True), StandardScaler()), nums))
        self.m = make_pipeline(make_column_transformer(*parts), LogisticRegression(C=0.5, max_iter=3000))

    def fit(self, df, y):
        self.m.fit(df[self.feats], y)
        return self

    def predict_proba(self, df):
        return self.m.predict_proba(df[self.feats])


MODELS = {"constant": lambda f: Constant(), "logit": Logit, "gbm": GBM}


def calibration(y, p, bins=10):
    """ECE over equal-count bins + calibration intercept/slope (logistic recalibration)."""
    y, p = np.asarray(y), np.clip(np.asarray(p), 1e-4, 1 - 1e-4)
    q = pd.qcut(p, bins, duplicates="drop", labels=False) if np.unique(p).size > bins else np.zeros(len(p), int)
    df = pd.DataFrame({"y": y, "p": p, "b": q})
    tab = df.groupby("b").agg(pred=("p", "mean"), obs=("y", "mean"), n=("y", "size"))
    ece = float((tab.n * (tab.pred - tab.obs).abs()).sum() / tab.n.sum())
    out = {"ece": ece}
    if np.unique(p).size > 1:
        lo = np.log(p / (1 - p)).reshape(-1, 1)
        lr = LogisticRegression(C=1e6, max_iter=1000).fit(lo, y)
        out.update({"cal_slope": float(lr.coef_[0][0]), "cal_intercept": float(lr.intercept_[0])})
    return out


def metrics(y, p):
    y = np.asarray(y)
    out = {"n": int(len(y)), "base_rate": float(y.mean()), "brier": float(brier_score_loss(y, p))}
    out["auc"] = float(roc_auc_score(y, p)) if np.unique(p).size > 1 and np.unique(y).size > 1 else 0.5
    out.update(calibration(y, p))
    return out


def recalibrate(p, recal):
    """Logistic recalibration z = a + b * logit(p)."""
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4)
    if not recal:
        return p
    return 1 / (1 + np.exp(-(recal["a"] + recal["b"] * np.log(p / (1 - p)))))


def predict_calibrated(bundle, df):
    """P(1,000-day license survival) from a saved step2 bundle, with its logistic recalibration."""
    return recalibrate(bundle["model"].predict_proba(df)[:, 1], bundle.get("recal"))


def hypothetical_frame(local, cuisine, zip_feats, zip_prior, person):
    """Feature rows for a NEW INDEPENDENT DINE-IN opening of `cuisine` at sampled points.
    local: competition columns per point (features.Competition.at), zip_feats: {ZIP_FEATS: value},
    zip_prior: smoothed ZIP survival history, person: {OPERATOR_FEATS + ADDRESS_FEATS: value}."""
    from features import same_cuisine_columns
    local = local.reset_index(drop=True)
    X = pd.concat([local, same_cuisine_columns(local, [cuisine] * len(local))], axis=1)
    X["cuisine"], X["format"], X["log_chain"], X["zip_prior_surv"] = cuisine, "dine_in", 0.0, zip_prior
    for f, v in {**zip_feats, **person}.items():
        X[f] = v
    return X


def site_curve(p_site, license_curve):
    """P(still licensed at month m), m = 0..72, for a site with 1,000-day estimate p_site (proportional hazards
    on the citywide Kaplan-Meier curve saved by step2)."""
    S, s1000 = np.asarray(license_curve["S_city"]), license_curve["S_city_1000d"]
    return S ** (np.log(np.clip(p_site, 1e-4, 1 - 1e-4)) / np.log(s1000))


class SiteSurvival:
    """1,000-day license survival for a new independent dine-in restaurant in one ZIP, re-scored with the
    user's own operator / address inputs. Exactly the step3 computation (same sampled points, ZIP context, ZIP
    history and cuisine weights); every input the user leaves out keeps the step3 default, i.e. the average of
    the ZIP's recent independent openings. Used by /api/survival and the recommend tool."""

    def __init__(self):
        import json
        import pickle

        from common import FIN_MAP, NOW, OUT
        from features import DATA_LAG, ZIP_FEATS, load_zip_panel, zip_year
        self.now, self.zip_feats_cols, self.fin_map = NOW, ZIP_FEATS, FIN_MAP
        self.bundle = pickle.load(open(OUT / "survival_model.pkl", "rb"))
        self.points = pd.read_parquet(OUT / "survival_points.parquet")
        self.defaults = json.loads((OUT / "survival_defaults.json").read_text())
        self.z = zip_year(load_zip_panel(), NOW.year - DATA_LAG)
        cai = pd.read_csv(OUT / "competitive_advantage_by_zip_cuisine.csv", dtype={"zip5": str})
        self.weights = {(r.zip5, r.cuisine): r.expected + 1 for r in cai.itertuples()}
        self._hist = None

    def history(self):
        if self._hist is None:      # ~2 s: built on the first address lookup only
            from common import OUT
            from features import LicenseHistory
            self._hist = LicenseHistory(pd.read_parquet(OUT / "license_spans.parquet"))
        return self._hist

    def person_inputs(self, zip5, prior_licenses=None, entity=None, address=None):
        """Feature values + where each came from ('user' or the step3 default source)."""
        from features import ACCT_CAP
        d = self.defaults["zips"][zip5]
        vals = dict(d["values"])
        used = {k: {"value": round(v, 4), "source": d["source"], "n_openings": d["n"]} for k, v in vals.items()}
        lookup = None
        if prior_licenses is not None:
            n = int(prior_licenses)
            if n < 0:
                raise ValueError("prior_licenses must be >= 0")
            vals["log_acct_prior_c"] = float(np.log1p(min(n, ACCT_CAP)))
            used["log_acct_prior_c"] = {"value": round(vals["log_acct_prior_c"], 4), "source": "user", "raw": n}
        if entity is not None:
            vals["entity"] = 1.0 if entity else 0.0
            used["entity"] = {"value": vals["entity"], "source": "user", "raw": bool(entity)}
        if address:
            from common import addr_norm
            ended, seen = self.history().addr_ended(address, self.now)
            vals["log_addr5_ended"] = float(np.log1p(ended))
            used["log_addr5_ended"] = {"value": round(vals["log_addr5_ended"], 4), "source": "user", "raw": address}
            lookup = {"normalized": addr_norm(address), "food_licenses_seen": seen, "ended_last_5y": ended,
                      "note": "Chicago Business Licenses at this exact street address; 0 licenses seen can also mean "
                              "the address is written differently in the license data"}
        return vals, used, lookup

    def score(self, zip5, cuisine, prior_licenses=None, entity=None, address=None):
        if zip5 not in self.defaults["zips"]:
            raise ValueError(f"ZIP {zip5} has no survival estimate (fewer than 30 restaurants or outside Chicago)")
        if cuisine not in self.fin_map and cuisine not in CUISINES:
            raise ValueError(f"cuisine must be one of {list(self.fin_map)} or a model group {CUISINES}")
        groups = self.fin_map.get(cuisine, [cuisine])
        vals, used, lookup = self.person_inputs(zip5, prior_licenses, entity, address)
        local = self.points[self.points.zip5 == zip5].drop(columns=["zip5", "lat", "lon"])
        zf = {f: self.z.at[zip5, f] for f in self.zip_feats_cols}
        prior = self.defaults["zip_prior"][zip5]

        def p_for(person):
            ps, ws = [], []
            for g in groups:
                ps.append(predict_calibrated(self.bundle, hypothetical_frame(local, g, zf, prior, person)).mean())
                ws.append(self.weights.get((zip5, g), 1.0))
            return float(np.average(ps, weights=ws))

        p, p_default = p_for(vals), p_for(self.defaults["zips"][zip5]["values"])
        curve = site_curve(p, self.bundle["license_curve"])
        return {"zip5": zip5, "cuisine": cuisine, "p_license_1000d": round(p, 4),
                "p_license_1000d_zip_default": round(p_default, 4), "inputs": used, "address_lookup": lookup,
                "license_curve": [round(float(v), 4) for v in curve],
                "model": {"kind": self.bundle["kind"], "feature_set": self.bundle["feature_set"]},
                "label": "1,000-day license survival estimate for a new independent dine-in restaurant; "
                         "license_curve[m] = P(license still active m months after opening)"}
