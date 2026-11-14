"""Point-in-time features: local competition around (lat, lon) at date t, plus ZIP context."""
import numpy as np
import pandas as pd

from common import CUISINES, EARTH_R, NON_REST, OUT, RADIUS_M, RAW, haversine_tree


class Competition:
    """Counts licenses active at t within RADIUS_M, weighted by classifier probabilities.

    Every license contributes p(cuisine) to that cuisine's count and 1 - p(non_restaurant)
    to the restaurant count, so uncertain names are counted fractionally.
    """

    def __init__(self, lic):
        lic = lic.dropna(subset=["lat", "lon", "start", "end"]).reset_index(drop=True)
        self.lic = lic
        self.tree = haversine_tree(lic.lat.values, lic.lon.values)
        self.start = lic.start.values.astype("datetime64[D]")
        self.end = lic.end.values.astype("datetime64[D]")
        self.p_rest = 1 - lic[f"p_{NON_REST}"].values
        self.p_cuis = lic[[f"p_{c}" for c in CUISINES]].values
        self.ids = lic.license_number.values

    def at(self, lat, lon, t, exclude=None):
        """Returns DataFrame with one row per query point."""
        idx = self.tree.query_radius(np.radians(np.c_[lat, lon]), r=RADIUS_M / EARTH_R)
        t = np.asarray(t).astype("datetime64[D]")
        rows = []
        for i, nb in enumerate(idx):
            if exclude is not None:
                nb = nb[self.ids[nb] != exclude[i]]
            s, e = self.start[nb], self.end[nb]
            ti = t[i]
            active = (s <= ti) & (e > ti)
            closed12 = (e <= ti) & (e > ti - 365)
            opened12 = (s <= ti) & (s > ti - 365)
            pr = self.p_rest[nb]
            same = self.p_cuis[nb][active].sum(0)
            row = {
                "n_food_active": float(active.sum()),
                "n_rest_active": float(pr[active].sum()),
                "n_rest_closed_12m": float(pr[closed12].sum()),
                "n_rest_opened_12m": float(pr[opened12].sum()),
            }
            for j, c in enumerate(CUISINES):
                row[f"same_{c}"] = float(same[j])
            rows.append(row)
        return pd.DataFrame(rows)


def same_cuisine_columns(df, cuisine):
    """Pick the same-cuisine count for each row's own cuisine and derive share features."""
    mat = df[[f"same_{c}" for c in CUISINES]].values
    pos = np.array([CUISINES.index(c) if c in CUISINES else -1 for c in cuisine])
    same = np.where(pos >= 0, mat[np.arange(len(df)), np.maximum(pos, 0)], np.nan)
    out = pd.DataFrame(index=df.index)
    out["n_same_active"] = same
    out["same_share"] = same / np.maximum(df.n_rest_active.values, 1)
    out["closure_rate_12m"] = df.n_rest_closed_12m / np.maximum(df.n_rest_active + df.n_rest_closed_12m, 1)
    return out


LODES_YEARS = range(2011, 2025)
POP_YEARS = (2018, 2021)   # Chicago Population Counts (85cm-7uqa) only covers 2018-2021
DATA_LAG = 2               # features for an opening in year Y use data year Y - 2 (publication lag)


POP_COLS = ["population_total", "population_latinx", "population_asian_non_latinx", "population_black_non_latinx",
            "population_white_non_latinx", "population_age_18_29", "population_age_30_39"]


def _pop_for_year(pop, y):
    """Per ZIP and per column: latest non-missing value with year <= y; if none, the earliest
    non-missing year (i.e. a later year -> flagged in pop_year_used, the max year actually used)."""
    rows = {}
    for zz, g in pop.groupby("geography"):
        g = g.sort_values("year")
        r, used = {}, []
        for c in POP_COLS:
            v = g[["year", c]].dropna()
            if v.empty:
                r[c] = np.nan
                continue
            le = v[v.year <= y]
            pick = le.iloc[-1] if len(le) else v.iloc[0]
            r[c] = float(pick[c])
            used.append(int(pick.year))
        r["pop_year_used"] = max(used) if used else np.nan
        rows[zz] = r
    return pd.DataFrame.from_dict(rows, orient="index")


def zip_panel(lic):
    """ZIP x data_year panel of context features (data_year 2011-2024).

    jobs:        LODES WAC of exactly data_year
    population:  Chicago Population Counts, latest year <= data_year (earliest available = 2018)
    income:      community-area socioeconomic indicators 2008-2012 (static; predates every opening)
    """
    pop_all = pd.read_csv(RAW / "pop" / "pop.csv", dtype={"geography": str})
    pop_all = pop_all[pop_all.geography_type == "ZIP Code"]
    xw = pd.read_csv(RAW / "lodes" / "il_xwalk.csv.gz", usecols=["tabblk2020", "zcta"], dtype=str)

    ses = pd.read_csv(RAW / "ses" / "ses.csv")
    ses = ses.dropna(subset=["ca"]).assign(ca=lambda d: d.ca.astype(int).astype(str)).set_index("ca")
    m = lic.dropna(subset=["community_area", "zip5"])
    m = m[m.community_area.isin(ses.index)]
    w = m.groupby(["zip5", "community_area"]).size().rename("w").reset_index()
    w = w.join(ses[["per_capita_income_", "hardship_index"]], on="community_area")
    inc = w.groupby("zip5").apply(lambda g: pd.Series({
        "income_pc": np.average(g.per_capita_income_, weights=g.w),
        "hardship": np.average(g.hardship_index, weights=g.w)}), include_groups=False)

    frames = []
    for y in LODES_YEARS:
        pop = _pop_for_year(pop_all, y)
        z = pd.DataFrame(index=pop.index.rename("zip5"))
        z["pop"] = pop.population_total.astype(float)
        for k in ["latinx", "asian_non_latinx", "black_non_latinx", "white_non_latinx"]:
            z[f"sh_{k.split('_')[0]}"] = pop[f"population_{k}"].astype(float) / z["pop"]
        z["sh_age_18_39"] = (pop.population_age_18_29 + pop.population_age_30_39).astype(float) / z["pop"]
        z["pop_year_used"] = pop.pop_year_used
        wac = pd.read_csv(RAW / "lodes" / f"il_wac_{y}.csv.gz", usecols=["w_geocode", "C000", "CNS18", "CE03"],
                          dtype={"w_geocode": str})
        jobs = wac.merge(xw, left_on="w_geocode", right_on="tabblk2020").groupby("zcta")[["C000", "CNS18", "CE03"]].sum()
        z["jobs"] = jobs.C000.reindex(z.index)
        z["food_jobs"] = jobs.CNS18.reindex(z.index)
        z["sh_high_wage_jobs"] = (jobs.CE03 / jobs.C000).reindex(z.index)
        z = z.join(inc)
        z["log_pop"] = np.log1p(z["pop"])
        z["log_jobs"] = np.log1p(z.jobs)
        z["log_food_jobs"] = np.log1p(z.food_jobs)
        z["jobs_per_res"] = z.jobs / z["pop"]
        z["data_year"] = y
        frames.append(z.reset_index())
    panel = pd.concat(frames, ignore_index=True)
    panel.to_csv(OUT / "zip_panel.csv", index=False)
    return panel


def load_zip_panel():
    return pd.read_csv(OUT / "zip_panel.csv", dtype={"zip5": str})


def zip_year(panel, data_year):
    """Context for one data year, indexed by zip5."""
    return panel[panel.data_year == data_year].set_index("zip5")


ZIP_FEATS = ["log_pop", "log_jobs", "log_food_jobs", "jobs_per_res", "sh_latinx", "sh_asian", "sh_black",
             "sh_white", "sh_age_18_39", "sh_high_wage_jobs", "income_pc", "hardship"]
LOCAL_FEATS = ["n_food_active", "n_rest_active", "n_rest_closed_12m", "n_rest_opened_12m",
               "n_same_active", "same_share", "closure_rate_12m"]
