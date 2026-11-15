"""Step 2b: how well does "license span >= 1,000 days" match actually staying in business?

Checks on every opening in the survival table:
  relocation   labeled closed, but the same account got a C_LOC (change of location) license within
               180 days of the end -> the business moved (Chicago issues a new license number)
  interrupted  a gap of > 60 days between one record's expiry and the next record's start
  relicensed   labeled closed, but another license with the same name at the same address started within
               180 days of the end  -> likely an ownership / entity change of the same restaurant
  inspections  Food Inspections (4ijn-s7e5) keyed by license number:
               labeled survived but an "Out of Business" result before day 1,000, or
               labeled closed but still inspected > 90 days after the license ended
Writes output/step2b_label_audit.json and output/step2b_label_samples.csv (cases to eyeball),
plus a sensitivity check: the same model validated on an alternative, business-level label.
"""
import json
import re

import numpy as np
import pandas as pd

from common import OUT, RAW, SURVIVAL_DAYS
from snapshot import snapshot_id
from survival import MODELS, metrics
from step2_survival_model import TEST_YEARS

op = pd.read_parquet(OUT / "survival_training_table.parquet")
sp = pd.read_parquet(OUT / "license_spans.parquet")
op["t"] = pd.to_datetime(op.t)
ids = set(op.license_number)
s = sp[sp.license_number.isin(ids)].sort_values(["license_number", "start"])


def addr_norm(a):
    a = re.sub(r"[^A-Z0-9 ]", " ", str(a).upper())
    a = re.sub(r"\b(1ST|2ND|FL|FLOOR|UNIT|STE|SUITE|BSMT|1|2|3|A|B)\s*$", "", a.strip())
    return re.sub(r"\s+", " ", a).strip()


# relocation: Chicago issues a NEW license number (application_type C_LOC) under the same account, so the
# old license simply ends. Flag closed openings whose account gets a C_LOC license within 180 days of the end.
from common import load_license_records  # noqa: E402
rec = load_license_records()
acct = rec.dropna(subset=["account_number"]).drop_duplicates("license_number").set_index("license_number").account_number
cl = rec[rec.application_type == "C_LOC"].copy()
cl["start"] = cl.license_start_date.fillna(cl.date_issued)
cl = cl.dropna(subset=["start"]).groupby(["account_number", "license_number"]).start.min().reset_index()
op["account_number"] = op.license_number.map(acct)
rl = op[op.survived == 0][["license_number", "account_number", "end"]].merge(cl, on="account_number", suffixes=("", "_new"))
rl = rl[(rl.license_number_new != rl.license_number) & ((rl.start - rl.end).dt.days.between(-180, 180))]
op["relocation"] = op.license_number.isin(set(rl.license_number))

# interruptions between consecutive records
s["prev_end"] = s.groupby("license_number").end.shift()
gap = (s.start - s.prev_end).dt.days
op["interrupted"] = op.license_number.isin(set(s[gap > 60].license_number))

# re-licensed under a new license number at the same address with the same name
sp["addr_n"] = sp.address.map(addr_norm)
first = sp.sort_values("start").drop_duplicates("license_number")[["license_number", "name_norm", "addr_n", "start"]]
op["addr_n"] = op.address.map(addr_norm)
cand = op[op.survived == 0][["license_number", "name_norm", "addr_n", "end"]].merge(
    first, on=["name_norm", "addr_n"], suffixes=("", "_new"))
cand = cand[(cand.license_number_new != cand.license_number)
            & ((cand.start - cand.end).dt.days.abs() <= 180)]
op["relicensed_same_name_addr"] = op.license_number.isin(set(cand.license_number))
# same address, different name, within 180 days (new tenant or rebrand: cannot tell)
cand2 = op[op.survived == 0][["license_number", "addr_n", "end"]].merge(first, on="addr_n", suffixes=("", "_new"))
cand2 = cand2[(cand2.license_number_new != cand2.license_number) & ((cand2.start - cand2.end).dt.days.between(-180, 180))]
op["same_addr_new_license"] = op.license_number.isin(set(cand2.license_number))

# inspections
ins = pd.read_csv(RAW / "inspections" / "by_license.csv", dtype={"license_": str}, parse_dates=["first_insp", "last_insp"])
oob = pd.read_csv(RAW / "inspections" / "oob_by_license.csv", dtype={"license_": str}, parse_dates=["first_oob"])
op = op.merge(ins.rename(columns={"license_": "license_number"}), on="license_number", how="left") \
       .merge(oob.rename(columns={"license_": "license_number"}), on="license_number", how="left")
op["has_inspection"] = op.last_insp.notna()
day1000 = op.t + pd.Timedelta(days=SURVIVAL_DAYS)
op["surv_but_oob_early"] = (op.survived == 1) & (op.first_oob < day1000)
op["closed_but_inspected_after"] = (op.survived == 0) & (op.last_insp > op.end + pd.Timedelta(days=90))

flags = ["relocation", "interrupted", "relicensed_same_name_addr", "same_addr_new_license",
         "surv_but_oob_early", "closed_but_inspected_after"]
rep = {"snapshot_id": snapshot_id(), "n": len(op), "share_with_inspection_record": float(op.has_inspection.mean())}
rep["flag_rates"] = {f: {"all": float(op[f].mean()),
                         "survived": float(op.loc[op.survived == 1, f].mean()),
                         "closed": float(op.loc[op.survived == 0, f].mean())} for f in flags}
# alternative business-level label: closed only if no sign the same business continued, and
# 'survived' flips to closed when inspections say Out of Business before day 1,000
alt = op.survived.copy()
alt[(op.survived == 0) & (op.relocation | op.relicensed_same_name_addr | op.closed_but_inspected_after)] = 1
alt[(op.survived == 1) & op.surv_but_oob_early] = 0
op["survived_alt"] = alt
rep["label_agreement_with_alt"] = float((op.survived == op.survived_alt).mean())
rep["flip_closed_to_survived"] = int(((op.survived == 0) & (alt == 1)).sum())
rep["flip_survived_to_closed"] = int(((op.survived == 1) & (alt == 0)).sum())
rep["survival_rate"] = {"license_label": float(op.survived.mean()), "alt_label": float(alt.mean())}

# sensitivity: chosen model, same rolling validation, scored against each label
import pickle  # noqa: E402
bundle = pickle.load(open(OUT / "survival_model.pkl", "rb"))
sens = {}
for lab in ["survived", "survived_alt"]:
    preds = []
    for Y in TEST_YEARS:
        tr = op[op.t + pd.Timedelta(days=SURVIVAL_DAYS) < pd.Timestamp(f"{Y}-01-01")]
        te = op[op.year == Y]
        m = MODELS[bundle["kind"]](bundle["feats"]).fit(tr, tr[lab])
        preds.append(pd.DataFrame({"y": te[lab].values, "p": m.predict_proba(te)[:, 1]}))
    P = pd.concat(preds)
    sens[lab] = {k: round(v, 4) for k, v in metrics(P.y, P.p).items()}
rep["model_vs_label"] = sens

# samples to eyeball
rng = np.random.default_rng(0)
cols = ["license_number", "name_norm", "address", "t", "end", "survived", "survived_alt", "first_insp", "last_insp", "first_oob"]
smp = []
for f in flags:
    g = op[op[f]]
    if len(g):
        smp.append(g.iloc[rng.choice(len(g), min(15, len(g)), replace=False)][cols].assign(flag=f))
pd.concat(smp).to_csv(OUT / "step2b_label_samples.csv", index=False)
json.dump(rep, open(OUT / "step2b_label_audit.json", "w"), indent=2)
print(json.dumps(rep, indent=2))
