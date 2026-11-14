"""Leave-one-ZIP-out Poisson model: expected number of cuisine-c places in each ZIP."""
import numpy as np
import pandas as pd
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

GAP_FEATS = ["log_pop", "log_jobs", "jobs_per_res", "sh_latinx", "sh_asian", "sh_black", "sh_white",
             "sh_age_18_39", "sh_high_wage_jobs", "income_pc"]
EXCLUDE_ZIPS = {"60666"}  # O'Hare airport


def loo_expected(counts, total, Xz):
    """counts: zips x cuisines, total: zips, Xz: zips x features. Returns (expected df, loo corr dict)."""
    X = Xz.fillna(Xz.median()).values
    n = len(total)
    expected = pd.DataFrame(index=counts.index, columns=counts.columns, dtype=float)
    corr = {}
    for c in counts.columns:
        rate = (counts[c] / total).values
        pred = np.empty(n)
        for i in range(n):
            m = np.arange(n) != i
            sc = StandardScaler().fit(X[m])
            pr = PoissonRegressor(alpha=1.0, max_iter=1000).fit(sc.transform(X[m]), rate[m], sample_weight=total.values[m])
            pred[i] = pr.predict(sc.transform(X[[i]]))[0] * total.values[i]
        expected[c] = pred
        corr[c] = float(np.corrcoef(pred, counts[c])[0, 1]) if counts[c].std() > 0 else 0.0
    return expected, corr


def gap_z(expected, counts):
    return (expected - counts) / np.sqrt(expected + 1)


def score_cai(df, w_gap=0.5):
    """(Re)compute gap_z, CAI and low_evidence on a table with columns
    actual, expected, p_survive_3y, gap_reliability. Used by step3 and by the live overlay."""
    df = df.copy()
    df["gap_z"] = gap_z(df.expected, df.actual)
    w = w_gap * df.gap_reliability
    df["CAI"] = 100 * (w * df.gap_z.rank(pct=True) + (1 - w) * df.p_survive_3y.rank(pct=True))
    df["low_evidence"] = (df.expected < 2) | (df.gap_reliability < 0.4)
    return df
