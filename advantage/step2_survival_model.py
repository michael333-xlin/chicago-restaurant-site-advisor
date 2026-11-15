"""Step 2: 1,000-day license survival model with leakage-free features and rolling-origin validation.

Sample   first ISSUE record with a dining / prepared-onsite activity, opened 2013-2022.
Label    survived = license still valid >= SURVIVAL_DAYS after it started (renewed at least once).
         The label counts as KNOWN only at t + SURVIVAL_DAYS.

Leakage controls (all features are computed as of the opening date t)
  * name, location, activity come from the opening's ISSUE record, not the license's latest record
  * cuisine = out-of-fold classifier prediction for that name (step1)
  * competition uses license records valid at t at their location at that time (features.Competition)
  * chain = number of OTHER licenses whose records used the same name before t
  * ZIP and city survival priors use only labels already known before t (no all-sample city mean)
  * ZIP context = data year t-2; population is missing before 2018 instead of backfilled
  * operator = OTHER licenses of the same account that started before t (capped at 10) and company vs person
    (legal name on the opening record); address history = food licenses at the same address that visibly
    ended (expiry + 60 days < t) within the 5 years before t. Fixed windows, so neither drifts with data start.
  * validation: for test cohort year Y, train only on openings whose label was known by Jan 1 of Y

License-duration curve: Kaplan-Meier of months until the license ends (censored at the data date), used to turn
the 1,000-day estimate of a site into P(still licensed at month m) under proportional hazards:
    S_site(m) = S_city(m) ** (log p_site / log S_city(1000 days)).
Its out-of-time check (predicted vs observed share still licensed at 12 / 24 / 36 months) is in the report.

Outputs  output/survival_training_table.parquet, output/survival_model.pkl, output/step2_survival_report.json
"""
import json
import pickle

import numpy as np
import pandas as pd

from common import COHORT_YEARS, CUISINES, NOW, OUT, SURVIVAL_DAYS
from features import (DATA_LAG, ZIP_FEATS, Competition, LicenseHistory, operator_address_columns,
                      same_cuisine_columns, zip_panel)
from snapshot import snapshot_id
from survival import ALL, MODELS, feature_set, metrics, recalibrate

TEST_YEARS = range(2018, 2023)
K_PRIOR = 20
ABLATIONS = {
    "full": (),
    "no_chain": ("chain",),
    "no_chain_no_local": ("chain", "local_competition"),
    "no_chain_no_local_no_operator": ("chain", "local_competition", "operator"),
    "no_chain_no_local_no_address": ("chain", "local_competition", "address_history"),
    # the model chosen before operator / address history existed (kept for comparison)
    "no_chain_no_local_no_operator_address": ("chain", "local_competition", "operator", "address_history"),
    "no_chain_no_zip": ("chain", "zip_context", "zip_history"),
    "location_only": ("cuisine_format", "chain", "operator"),
    "cuisine_format_only": ("chain", "local_competition", "zip_context", "zip_history", "operator", "address_history"),
}
KM_MONTHS = 72                  # license-duration curve horizon (the web app simulates 72 months)
DAYS_PER_MONTH = 30.4375


def build_table():
    sp = pd.read_parquet(OUT / "license_spans.parquet")
    life_end = sp.groupby("license_number").end.max()
    iss = sp[(sp.application_type == "ISSUE") & sp.business_activity.str.contains("Dining|Prepared Onsite", na=False)]
    op = iss.sort_values("start").drop_duplicates("license_number").rename(columns={"start": "t"})
    op = op.dropna(subset=["t", "lat", "lon"])
    op = op[op.t.dt.year.isin(COHORT_YEARS)].reset_index(drop=True)
    op["end"] = op.license_number.map(life_end)
    op["survived"] = ((op.end - op.t).dt.days >= SURVIVAL_DAYS).astype(int)
    op["year"] = op.t.dt.year
    pc = [f"p_{c}" for c in CUISINES]
    best = op[pc].idxmax(axis=1).str[2:]
    conf = op[pc + ["p_non_restaurant"]].max(axis=1)
    op["cuisine"] = np.where((conf >= 0.5) & (op[pc].max(axis=1) == conf), best, "unknown")
    op["format"] = np.select(
        [op.business_activity.str.contains("Without Dining", na=False),
         op.business_activity.str.contains("With Seating|With Dining", na=False)], ["takeout", "dine_in"], "other")

    # chain: other licenses that used this name on a record starting before t
    first_use = sp.dropna(subset=["name_norm"]).groupby(["name_norm", "license_number"]).start.min().reset_index()
    by_name = {n: np.sort(g.start.values.astype("datetime64[D]")) for n, g in first_use.groupby("name_norm")}
    tt = op.t.values.astype("datetime64[D]")
    op["log_chain"] = np.log1p([
        np.searchsorted(by_name[n], tt[i], side="left") if isinstance(n, str) and len(n) > 2 and n in by_name else 0
        for i, n in enumerate(op.name_norm)])

    # operator experience and address history as of t
    op = pd.concat([op, operator_address_columns(op, LicenseHistory(sp))], axis=1)

    # survival priors from labels known before t
    known = (op.t + pd.Timedelta(days=SURVIVAL_DAYS)).values
    order = np.argsort(known)
    kt, ks, kz = known[order], op.survived.values[order], op.zip5.values[order]
    n_city = np.searchsorted(kt, op.t.values)
    cs = np.r_[0, np.cumsum(ks)]
    city = np.where(n_city > 0, cs[n_city] / np.maximum(n_city, 1), np.nan)
    zp = np.full(len(op), np.nan)
    for z5 in pd.unique(op.zip5.dropna()):
        m = kz == z5
        kt_z, cz = kt[m], np.r_[0, np.cumsum(ks[m])]
        rows = np.nonzero(op.zip5.values == z5)[0]
        n = np.searchsorted(kt_z, op.t.values[rows])
        zp[rows] = (cz[n] + K_PRIOR * city[rows]) / (n + K_PRIOR)
    op["zip_prior_surv"] = zp              # NaN until the first labels mature (late 2015)
    op["city_prior_known"] = city

    comp = Competition(sp)
    local = comp.at(op.lat.values, op.lon.values, op.t.values, exclude=op.license_number.values)
    op = pd.concat([op, local, same_cuisine_columns(local, op.cuisine)], axis=1)
    panel = zip_panel(sp)
    op["data_year"] = op.year - DATA_LAG
    op = op.merge(panel[["zip5", "data_year", "pop_year_used"] + ZIP_FEATS], on=["zip5", "data_year"], how="left")
    return op


def rolling_eval(op, feats_by_name, models=("constant", "logit", "gbm"), subsets=("all", "independent")):
    """Returns per-fold rows and pooled metrics for each (feature set, model, subset)."""
    preds, folds = [], []
    first_fs = list(feats_by_name)[0]
    for Y in TEST_YEARS:
        cutoff = pd.Timestamp(f"{Y}-01-01")
        tr = op[op.t + pd.Timedelta(days=SURVIVAL_DAYS) < cutoff]
        te = op[op.year == Y]
        for fs_name, feats in feats_by_name.items():
            for mk in models:
                if mk == "constant" and fs_name != first_fs:
                    continue
                m = MODELS[mk](feats).fit(tr, tr.survived)
                p = m.predict_proba(te)[:, 1]
                preds.append(pd.DataFrame({"fold": Y, "fs": fs_name, "model": mk, "y": te.survived.values, "p": p,
                                           "independent": (te.log_chain == 0).values}))
                folds.append({"fold": Y, "fs": fs_name, "model": mk, "n_train": len(tr), **metrics(te.survived, p)})
    P = pd.concat(preds)
    pooled = []
    for (fs, mk), g in P.groupby(["fs", "model"]):
        for sub in subsets:
            gg = g if sub == "all" else g[g.independent]
            per_fold = [metrics(h.y, h.p)["auc"] for _, h in gg.groupby("fold")]
            pooled.append({"fs": fs, "model": mk, "subset": sub, **metrics(gg.y, gg.p),
                           "auc_fold_mean": float(np.mean(per_fold)), "auc_fold_sd": float(np.std(per_fold))})
    return pd.DataFrame(folds), pd.DataFrame(pooled)


def km_curve(dur_days, event, months=KM_MONTHS):
    """Kaplan-Meier S(m) on a monthly grid m = 0..months. dur_days: days observed, event: 1 = license ended."""
    dur, ev = np.asarray(dur_days, float), np.asarray(event, bool)
    times = np.sort(np.unique(dur[ev]))
    n_at = np.array([(dur >= x).sum() for x in times])
    d_at = np.array([((dur == x) & ev).sum() for x in times])
    s = np.cumprod(1 - d_at / n_at)
    grid = np.arange(months + 1) * DAYS_PER_MONTH
    idx = np.searchsorted(times, grid, side="right") - 1
    return np.where(idx >= 0, s[np.maximum(idx, 0)], 1.0)


def km_at(curve, days):
    """S at a number of days, linear between monthly grid points."""
    m = days / DAYS_PER_MONTH
    return float(np.interp(m, np.arange(len(curve)), curve))


def durations(df, cutoff):
    """Days from opening until the license ended, censored at cutoff (event = ended before cutoff)."""
    end = df.end.where(df.end < cutoff, cutoff)
    return (end - df.t).dt.days.values, (df.end < cutoff).values


if __name__ == "__main__":
    op = build_table()
    op.to_parquet(OUT / "survival_training_table.parquet")
    rep = {"snapshot_id": snapshot_id(), "n_openings": len(op), "survival_rate": float(op.survived.mean()),
           "share_independent": float((op.log_chain == 0).mean()),
           "share_pop_missing": float(op.log_pop.isna().mean()),
           "validation": "rolling origin, test cohort years 2018-2022; train = openings with label known before Jan 1 of test year"}

    feats = {k: feature_set(v) for k, v in ABLATIONS.items()}
    folds, pooled = rolling_eval(op, feats)
    rep["pooled"] = pooled.round(4).to_dict("records")
    rep["per_fold"] = folds.round(4).to_dict("records")

    # original (pre-fix) feature table, same rolling validation, for comparison
    old_path = sorted((OUT / "versions").glob("v1_*/survival_training_table.parquet"))
    if old_path:
        old = pd.read_parquet(old_path[0])
        old["t"] = pd.to_datetime(old.t)
        # an older table may predate later feature groups (operator, address history): use the columns it has
        _, old_pooled = rolling_eval(old, {"full": [f for f in ALL if f in old.columns]})
        rep["original_table_same_validation"] = old_pooled.round(4).to_dict("records")
        rep["original_table_source"] = old_path[0].parent.name   # whichever versions/v1_* exists on this disk

    # final model: best pooled AUC on independent restaurants (simpler set wins ties within 0.005)
    ind = pooled[(pooled.subset == "independent") & (pooled.model != "constant")].copy()
    ind["n_feats"] = ind.fs.map(lambda f: len(feats[f]))
    top = ind.auc.max()
    pick = ind[ind.auc >= top - 0.005].sort_values(["n_feats", "auc"], ascending=[True, False]).iloc[0]
    final = MODELS[pick.model](feats[pick.fs]).fit(op, op.survived)
    # rolling out-of-time predictions of the chosen model: recalibration (slope < 1 = too extreme), the metrics the
    # retrain guardrail compares, and the check of the license-duration curve
    oof = []
    for Y in TEST_YEARS:
        cutoff = pd.Timestamp(f"{Y}-01-01")
        tr = op[op.t + pd.Timedelta(days=SURVIVAL_DAYS) < cutoff]
        te = op[op.year == Y]
        curve = km_curve(*durations(tr, cutoff))       # license-duration curve known at the cutoff
        oof.append(pd.DataFrame({"fold": Y, "y": te.survived.values, "independent": (te.log_chain == 0).values,
                                 "dur": (te.end - te.t).dt.days.values,
                                 "p": MODELS[pick.model](feats[pick.fs]).fit(tr, tr.survived).predict_proba(te)[:, 1],
                                 "km_1000": km_at(curve, SURVIVAL_DAYS)}))
        oof[-1]["km_curve"] = [curve] * len(te)
    oof = pd.concat(oof, ignore_index=True)
    from sklearn.linear_model import LogisticRegression
    lo = np.log(np.clip(oof.p, 1e-4, 1 - 1e-4) / (1 - np.clip(oof.p, 1e-4, 1 - 1e-4))).values.reshape(-1, 1)
    rc = LogisticRegression(C=1e6, max_iter=1000).fit(lo, oof.y)
    recal = {"a": float(rc.intercept_[0]), "b": float(rc.coef_[0][0])}
    pc = 1 / (1 + np.exp(-(recal["a"] + recal["b"] * lo.ravel())))
    rep["recalibration"] = {**recal, "oof_before": metrics(oof.y, oof.p), "oof_after_in_sample": metrics(oof.y, pc)}
    const_oof = pooled.query("model=='constant'").set_index("subset").brier
    ind_m = metrics(oof.y[oof.independent], oof.p[oof.independent])
    rep["final_model"] = {
        "model": pick.model, "feature_set": pick.fs, "n": int(len(oof)),
        "auc_all": metrics(oof.y, oof.p)["auc"], "auc_independent": ind_m["auc"],
        "brier_all": metrics(oof.y, oof.p)["brier"], "brier_independent": ind_m["brier"],
        "brier_constant_all": float(const_oof["all"]), "brier_constant_independent": float(const_oof["independent"]),
        "auc_by_test_year_independent": {int(Y): metrics(g.y, g.p)["auc"] for Y, g in oof[oof.independent].groupby("fold")},
        "note": "pooled rolling out-of-time predictions of the deployed model (before recalibration)"}

    # license-duration curve: final curve on every opening (censored at NOW) + out-of-time check of the
    # proportional-hazards transfer. Recalibration is cross-fitted (fit on the other test years) for the check.
    d_all, e_all = durations(op, NOW)
    km_final = km_curve(d_all, e_all)
    chk = []
    for Y, g in oof.groupby("fold"):
        o = oof[oof.fold != Y]
        lo_o = np.log(np.clip(o.p, 1e-4, 1 - 1e-4) / (1 - np.clip(o.p, 1e-4, 1 - 1e-4))).values.reshape(-1, 1)
        r = LogisticRegression(C=1e6, max_iter=1000).fit(lo_o, o.y)
        p_cal = recalibrate(g.p.values, {"a": float(r.intercept_[0]), "b": float(r.coef_[0][0])})
        curve, k1000 = g.km_curve.iloc[0], g.km_1000.iloc[0]
        expo = np.log(p_cal) / np.log(k1000)
        for mth in (12, 24, 36):
            pred = curve[mth] ** expo
            obs = (g.dur.values >= mth * DAYS_PER_MONTH).astype(float)
            dec = pd.qcut(pred, 5, labels=False, duplicates="drop")
            by_q = pd.DataFrame({"pred": pred, "obs": obs, "q": dec}).groupby("q").mean()
            chk.append({"test_year": int(Y), "month": mth, "pred_mean": float(pred.mean()), "obs_mean": float(obs.mean()),
                        "quintile_abs_err": float((by_q.pred - by_q.obs).abs().mean()),
                        "auc": float(metrics(obs, pred)["auc"]) if 0 < obs.mean() < 1 else None})
    chk = pd.DataFrame(chk)
    rep["license_curve"] = {
        "months": KM_MONTHS, "S_city": [round(float(v), 4) for v in km_final],
        "S_city_1000d": km_at(km_final, SURVIVAL_DAYS),
        "out_of_time_check": chk.round(4).to_dict("records"),
        "summary_by_month": chk.groupby("month")[["pred_mean", "obs_mean", "quintile_abs_err", "auc"]].mean().round(4).to_dict("index"),
        "method": "Kaplan-Meier of license duration (censored at the data date); site curve = S_city(m) ** "
                  "(log p_site / log S_city(1000 d)) (proportional hazards)"}
    pickle.dump({"model": final, "feats": feats[pick.fs], "kind": pick.model, "feature_set": pick.fs,
                 "recal": recal, "license_curve": {"S_city": km_final.tolist(), "S_city_1000d": km_at(km_final, SURVIVAL_DAYS)}},
                open(OUT / "survival_model.pkl", "wb"))
    rep["chosen"] = {"model": pick.model, "feature_set": pick.fs, "independent_auc": float(pick.auc)}
    full_gbm = pooled.query("fs=='full' and model=='gbm' and subset=='all'").iloc[0]
    const = pooled.query("model=='constant' and subset=='all'").iloc[0]
    rep.update({"auc_gbm": float(full_gbm.auc), "brier_gbm": float(full_gbm.brier),
                "brier_constant": float(const.brier), "auc_chosen_independent": float(pick.auc)})
    json.dump(rep, open(OUT / "step2_survival_report.json", "w"), indent=2, default=float)

    pd.set_option("display.width", 200)
    show = pooled[pooled.fs.isin(["full", "no_chain"])]
    print(show[["fs", "model", "subset", "n", "auc", "auc_fold_mean", "auc_fold_sd", "brier", "ece", "cal_slope"]]
          .round(4).to_string(index=False))
    print("\nablations (independent, pooled AUC):")
    print(pooled[pooled.subset == "independent"].pivot(index="fs", columns="model", values="auc").round(4).to_string())
    if old_path:
        print("\noriginal table, same validation:")
        print(old_pooled[["model", "subset", "auc", "brier", "ece"]].round(4).to_string(index=False))
    print("\nchosen:", rep["chosen"])
    print("final model (deployed, out-of-time):", {k: v for k, v in rep["final_model"].items() if k != "note"})
    print("license curve check (mean over test years):", rep["license_curve"]["summary_by_month"])
