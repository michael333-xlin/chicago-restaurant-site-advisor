"""Point-in-time features: local competition around (lat, lon) at date t, operator experience and address
history at date t, plus ZIP context."""
import re

import numpy as np
import pandas as pd

from common import CUISINES, EARTH_R, NON_REST, OUT, RADIUS_M, RAW, addr_norm, haversine_tree


class Competition:
    """Point-in-time competition around (lat, lon) at date t, from license RECORDS (output/license_spans).

    A license counts at the location and under the name it had on the record that covers t, so later
    relocations / renames do not leak backwards. Each license contributes p(cuisine) to that cuisine's count
    and 1 - p(non_restaurant) to the restaurant count (soft counts, out-of-fold classifier probabilities).
      active        a record of the license covers t
      closed_12m    the license's latest record starting <= t ended in [t-365, t)
      opened_12m    the license's first record started in (t-365, t]
    """

    def __init__(self, spans):
        sp = spans.dropna(subset=["lat", "lon", "start", "end"]).reset_index(drop=True)
        self.tree = haversine_tree(sp.lat.values, sp.lon.values)
        self.start = sp.start.values.astype("datetime64[D]")
        self.end = sp.end.values.astype("datetime64[D]")
        self.ids = pd.factorize(sp.license_number)[0]
        self.raw_ids = sp.license_number.values
        self.p_rest = 1 - sp[f"p_{NON_REST}"].fillna(0).values
        self.p_cuis = sp[[f"p_{c}" for c in CUISINES]].fillna(0).values
        first = sp.groupby("license_number").start.min()
        self.first_start = sp.license_number.map(first).values.astype("datetime64[D]")

    def at(self, lat, lon, t, exclude=None):
        idx = self.tree.query_radius(np.radians(np.c_[lat, lon]), r=RADIUS_M / EARTH_R)
        t = np.asarray(t).astype("datetime64[D]")
        rows = []
        for i, nb in enumerate(idx):
            if exclude is not None:
                nb = nb[self.raw_ids[nb] != exclude[i]]
            ti = t[i]
            nb = nb[self.start[nb] <= ti]                 # only records that exist by t
            if len(nb) == 0:
                rows.append({"n_food_active": 0.0, "n_rest_active": 0.0, "n_rest_closed_12m": 0.0,
                             "n_rest_opened_12m": 0.0, **{f"same_{c}": 0.0 for c in CUISINES}})
                continue
            ids, s, e = self.ids[nb], self.start[nb], self.end[nb]
            act = e > ti
            # active: unique licenses with a covering record (first covering record supplies the probs)
            a_nb, a_first = np.unique(ids[act], return_index=True)
            a_rows = nb[act][a_first]
            # per license: latest end among records known by t
            order = np.lexsort((e, ids))
            ids_o, last_idx = ids[order], np.r_[np.nonzero(np.diff(ids[order]))[0], len(order) - 1]
            lic_last_end = e[order][last_idx]
            lic_row = nb[order][last_idx]
            closed = (lic_last_end <= ti) & (lic_last_end > ti - 365)
            opened = (self.first_start[lic_row] > ti - 365)
            row = {"n_food_active": float(len(a_nb)),
                   "n_rest_active": float(self.p_rest[a_rows].sum()),
                   "n_rest_closed_12m": float(self.p_rest[lic_row[closed]].sum()),
                   "n_rest_opened_12m": float(self.p_rest[lic_row[opened]].sum())}
            same = self.p_cuis[a_rows].sum(0)
            for j, c in enumerate(CUISINES):
                row[f"same_{c}"] = float(same[j])
            rows.append(row)
        return pd.DataFrame(rows)


# ---------------------------------------------------------------- operator experience and address history
OPERATOR_FEATS = ["log_acct_prior_c", "entity"]
ADDRESS_FEATS = ["log_addr5_ended"]
ACCT_CAP = 10                 # 10+ earlier licenses = experienced multi-unit operator (keeps the logit from extrapolating)
ADDR_WINDOW_DAYS = 5 * 365    # fixed look-back, so the feature does not drift with how far back the license data goes
GRACE_DAYS = 60               # a license counts as ended only 60 days after its last expiry (late renewals)
_ENTITY = re.compile(r"\b(?:LLC|L\.L\.C|INC|CORP|CORPORATION|LTD|CO\.|COMPANY)\b")


def is_entity(legal_name):
    """1.0 if the licensee is a company (LLC / Inc / Corp ...), 0.0 for a person."""
    return float(bool(_ENTITY.search(str(legal_name or "").upper())))


class LicenseHistory:
    """Per license (from output/license_spans): first account number, legal name and normalized address,
    first start and final end. Answers point-in-time questions about an operator or an address."""

    def __init__(self, spans):
        g = spans.sort_values("start").groupby("license_number")
        self.lic = pd.DataFrame({"account": g.account_number.first(), "legal": g.legal_name.first(),
                                 "addr": g.address.first().map(addr_norm),
                                 "first_start": g.start.min(), "final_end": g.end.max()})
        self.by_acct = {k: d for k, d in self.lic.groupby("account")}
        self.by_addr = {k: d for k, d in self.lic.groupby("addr") if len(k) > 5}

    def acct_prior(self, account, t, exclude=None):
        """Other licenses of this account that started before t."""
        d = self.by_acct.get(account) if isinstance(account, str) else None
        if d is None:
            return 0
        m = d.first_start.values < np.datetime64(t, "ns")
        if exclude is not None:
            m &= d.index.values != exclude
        return int(m.sum())

    def addr_ended(self, address, t, exclude=None):
        """(food licenses at this address that visibly ended in the ADDR_WINDOW_DAYS before t,
            food licenses ever seen at this address before t)."""
        d = self.by_addr.get(addr_norm(address))
        if d is None:
            return 0, 0
        t = np.datetime64(t, "ns")
        m = d.first_start.values < t
        if exclude is not None:
            m &= d.index.values != exclude
        end = d.final_end.values
        ended = m & (end + np.timedelta64(GRACE_DAYS, "D") < t) & (end + np.timedelta64(ADDR_WINDOW_DAYS, "D") > t)
        return int(ended.sum()), int(m.sum())

    def features(self, account, legal_name, address, t, exclude=None):
        return {"log_acct_prior_c": float(np.log1p(min(self.acct_prior(account, t, exclude), ACCT_CAP))),
                "entity": is_entity(legal_name),
                "log_addr5_ended": float(np.log1p(self.addr_ended(address, t, exclude)[0]))}


def operator_address_columns(op, hist):
    """OPERATOR_FEATS + ADDRESS_FEATS for every opening in op (columns license_number, t), as of its own t."""
    rows = [hist.features(hist.lic.account.get(lid), hist.lic.legal.get(lid), addr, t, exclude=lid)
            for lid, addr, t in zip(op.license_number.values, op.address.values, op.t.values)]
    return pd.DataFrame(rows, index=op.index)


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


# every WAC year on disk from 2011 (step0 downloads 2011-2024; a later refresh can add newer years)
LODES_YEARS = sorted(int(p.name.split("_")[-1][:4]) for p in RAW.glob("lodes/il_wac_*.csv.gz")
                     if int(p.name.split("_")[-1][:4]) >= 2011) or list(range(2011, 2025))
POP_YEARS = (2018, 2021)   # Chicago Population Counts (85cm-7uqa) only covers 2018-2021
DATA_LAG = 2               # features for an opening in year Y use data year Y - 2 (publication lag)


POP_COLS = ["population_total", "population_latinx", "population_asian_non_latinx", "population_black_non_latinx",
            "population_white_non_latinx", "population_age_18_29", "population_age_30_39"]


def _pop_for_year(pop, y):
    """Per ZIP and per column: latest non-missing value with year <= y; missing if none (no backfill
    from later years). pop_year_used = latest year actually used (NaN if none)."""
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
            if not len(le):                 # no data published by data year y: leave missing (no backfill)
                r[c] = np.nan
                continue
            pick = le.iloc[-1]
            r[c] = float(pick[c])
            used.append(int(pick.year))
        r["pop_year_used"] = max(used) if used else np.nan
        rows[zz] = r
    return pd.DataFrame.from_dict(rows, orient="index")


def zip_panel(lic):
    """ZIP x data_year panel of context features (data_year 2011-2024).

    jobs:        LODES WAC of exactly data_year
    population:  Chicago Population Counts, latest year <= data_year; missing before 2018 (no backfill)
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
    """Context for one data year, indexed by zip5 (latest available year if data_year is not out yet)."""
    data_year = min(int(data_year), int(panel.data_year.max()))
    return panel[panel.data_year == data_year].set_index("zip5")


ZIP_FEATS = ["log_pop", "log_jobs", "log_food_jobs", "jobs_per_res", "sh_latinx", "sh_asian", "sh_black",
             "sh_white", "sh_age_18_39", "sh_high_wage_jobs", "income_pc", "hardship"]
LOCAL_FEATS = ["n_food_active", "n_rest_active", "n_rest_closed_12m", "n_rest_opened_12m",
               "n_same_active", "same_share", "closure_rate_12m"]
