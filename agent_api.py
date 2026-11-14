"""Agent interface: tools an LLM agent (or a web backend) can call, plus the self-iteration loop.

Two update speeds:
  * live (seconds):  exa_fetch / ingest_records write to data/live/, recommend(use_live=True) overlays them.
  * retrain (~3 min): re-download the official datasets, rerun step1-step4, and promote the new models
                      only if they are not worse than the current ones (guardrail). Schedule it e.g. weekly.

CLI
    python3 advantage/agent_api.py tools                                   # print tool schemas (JSON)
    python3 advantage/agent_api.py fetch --area "West Loop" --zip5 60607 --cuisine asian
    python3 advantage/agent_api.py ingest --kind rents --file my_rents.json
    python3 advantage/agent_api.py recommend --budget 350000 --cuisine asian --live
    python3 advantage/agent_api.py retrain [--no-download]
    python3 advantage/agent_api.py status

Python / agent
    from agent_api import TOOLS, call_tool
    call_tool("recommend", {"budget": 350000, "cuisine": "asian", "use_live": True})
"""
import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from common import FIN_MAP, OUT, ROOT
from live import KINDS, SCHEMAS, LiveStore

HERE = ROOT / "advantage"
VERSIONS = OUT / "versions"
REGISTRY = OUT / "model_registry.json"
ARTIFACTS = ["cuisine_classifier.pkl", "licenses_with_cuisine.parquet", "survival_model.pkl",
             "survival_training_table.parquet", "zip_panel.csv", "competitive_advantage_by_zip_cuisine.csv",
             "top3_cuisines_per_zip.csv", "top3_zips_per_cuisine.csv", "finance_risk_adjusted.csv",
             "step1_classifier_report.json", "step2_survival_report.json", "step3_report.json",
             "step4_backtest_report.json"]
STEPS = ["step1_cuisine_classifier.py", "step2_survival_model.py", "step3_advantage_index.py", "step4_backtest_gap.py"]
# promotion guardrail: new model may not be meaningfully worse than the current one
MAX_AUC_DROP = 0.02
MAX_CLASSIFIER_ACC_DROP = 0.03
KEEP_VERSIONS = 5           # promoted snapshots kept on disk (~19 MB each)


# ------------------------------------------------------------------ self-iteration
def _metrics():
    s1 = json.loads((OUT / "step1_classifier_report.json").read_text())
    s2 = json.loads((OUT / "step2_survival_report.json").read_text())
    s4 = json.loads((OUT / "step4_backtest_report.json").read_text())
    return {"classifier_acc": s1["holdout_accuracy_cuisine_only"], "survival_auc_gbm": s2["auc_gbm"],
            "survival_brier_gbm": s2["brier_gbm"], "brier_constant": s2["brier_constant"],
            "n_openings": s2["n_openings"], "backtest_gap_p": s4["logit_gap_p_controlled"]}


def _registry():
    return json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []


def _snapshot(tag):
    d = VERSIONS / tag
    d.mkdir(parents=True, exist_ok=True)
    for a in ARTIFACTS:
        if (OUT / a).exists():
            shutil.copy2(OUT / a, d / a)
    return d


def _restore(tag):
    for a in ARTIFACTS:
        if (VERSIONS / tag / a).exists():
            shutil.copy2(VERSIONS / tag / a, OUT / a)


def current_version():
    promoted = [r for r in _registry() if r["promoted"]]
    return promoted[-1] if promoted else None


def retrain(download=True, force=False):
    """Refresh data, retrain, compare with the current promoted version, promote or roll back."""
    reg = _registry()
    if current_version() is None:       # bootstrap: register what is on disk as the first version
        tag = "v0_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        _snapshot(tag)
        reg.append({"version": tag, "created_at": tag[3:], "metrics": _metrics(), "promoted": True,
                    "note": "bootstrap from existing outputs"})
        REGISTRY.write_text(json.dumps(reg, indent=2))
    prev = current_version()
    log = []
    if download:
        r = subprocess.run(["bash", str(HERE / "step0_download.sh")], cwd=ROOT, capture_output=True, text=True)
        log.append({"step": "step0_download.sh", "rc": r.returncode, "tail": r.stdout[-300:] + r.stderr[-300:]})
        if r.returncode:
            return {"promoted": False, "reason": "download failed", "log": log, "current": prev["version"]}
    for st in STEPS:
        r = subprocess.run([sys.executable, str(HERE / st)], cwd=ROOT, capture_output=True, text=True)
        log.append({"step": st, "rc": r.returncode, "tail": r.stderr[-400:] if r.returncode else ""})
        if r.returncode:
            _restore(prev["version"])
            return {"promoted": False, "reason": f"{st} failed; restored {prev['version']}", "log": log}
    new = _metrics()
    old = prev["metrics"]
    checks = {
        "survival_auc": new["survival_auc_gbm"] >= old["survival_auc_gbm"] - MAX_AUC_DROP,
        "beats_constant": new["survival_brier_gbm"] <= new["brier_constant"],
        "classifier_acc": new["classifier_acc"] >= old["classifier_acc"] - MAX_CLASSIFIER_ACC_DROP,
    }
    ok = force or all(checks.values())
    tag = "v" + str(len(reg)) + "_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if ok:
        _snapshot(tag)
    else:
        _restore(prev["version"])
    entry = {"version": tag, "created_at": tag.split("_", 1)[1], "metrics": new, "previous": prev["version"],
             "checks": checks, "promoted": ok, "forced": force}
    reg.append(entry)
    REGISTRY.write_text(json.dumps(reg, indent=2))
    keep = {r["version"] for r in reg if r["promoted"]}
    keep = set(sorted(keep, key=lambda v: v.split("_", 1)[1])[-KEEP_VERSIONS:])
    for d in VERSIONS.iterdir():
        if d.is_dir() and d.name not in keep:
            shutil.rmtree(d)
    return {**entry, "log": log}


# ------------------------------------------------------------------ tools
def _engine(use_live):
    from recommend import Engine
    return Engine(live=LiveStore() if use_live else None)


def tool_recommend(budget, cuisine, space_type="new", traffic_shock=1.0, food_shock=1.0, use_live=True,
                   top_n=5, full=False):
    eng = _engine(use_live)
    res = eng.recommend(budget, cuisine, space_type, traffic_shock, food_shock, top_n)
    eng.map_geojson(res)
    if full:
        return res
    # compact view for an LLM context window
    keep = ["area", "score", "boundary", "subscores", "reasons", "competition", "survival_history",
            "demographics", "risk", "space_comparison", "live"]
    top = []
    for x in res["top"]:
        y = {k: x[k] for k in keep if k in x}
        f = x["finance"]
        y["finance"] = {"store": f["store"], "base": f["scenarios"]["base"], "ratios": f["ratios"],
                        "payback_months": {k: v["payback_months"] for k, v in f["scenarios"].items()},
                        "rent_psf_year": f["rent_psf_year"], "rent_source": f["rent_source"]}
        top.append(y)
    return {**{k: res[k] for k in ["inputs", "all_ranked", "excluded", "live_data", "method", "sources"]}, "top": top}


def tool_exa_fetch(area, cuisine, zip5=None, topics=None, num_results=8, days_back=180):
    from exa_fetch import TOPICS, fetch_area
    return fetch_area(area, cuisine, zip5=zip5, topics=tuple(topics or TOPICS), num_results=num_results,
                      days_back=days_back)


def tool_ingest_records(kind, records, extractor="agent"):
    return LiveStore().ingest(kind, records, extractor=extractor)


def tool_live_status():
    return {"live": LiveStore().summary(), "model": current_version()}


def tool_retrain(download=True):
    r = retrain(download=download)
    r.pop("log", None)
    return r


def _schema_props(kind):
    props = {}
    for f, spec in SCHEMAS[kind].items():
        if f.startswith("_"):
            continue
        typ = spec[0]
        props[f] = {"type": "number" if typ is float else "string"}
        if typ == "date":
            props[f]["description"] = "YYYY-MM-DD"
    return props


TOOLS = [
    {"name": "recommend",
     "description": "Rank Chicago neighborhoods for opening a restaurant: score, store size, monthly P&L, payback, "
                    "survival odds, warnings, competition, demographics, and live evidence. All numbers carry sources.",
     "input_schema": {"type": "object", "properties": {
         "budget": {"type": "number", "description": "total budget in USD"},
         "cuisine": {"type": "string", "enum": list(FIN_MAP)},
         "space_type": {"type": "string", "enum": ["new", "second_gen"], "description": "new build-out or take over an existing restaurant space"},
         "traffic_shock": {"type": "number", "description": "1.0 = normal, 0.7 = 30% fewer customers"},
         "food_shock": {"type": "number", "description": "1.0 = normal, 1.15 = food costs +15%"},
         "use_live": {"type": "boolean", "description": "overlay live records ingested from the web"},
         "top_n": {"type": "integer"}},
         "required": ["budget", "cuisine"]}},
    {"name": "exa_fetch",
     "description": "Search the web with Exa for fresh info about one area (rents, openings, closures, menu prices, "
                    "developments). Rents and news signals are auto-extracted and stored; returns page texts so you "
                    "can extract openings/closures/prices yourself and send them to ingest_records.",
     "input_schema": {"type": "object", "properties": {
         "area": {"type": "string", "description": "neighborhood name, e.g. 'West Loop'"},
         "cuisine": {"type": "string", "enum": list(FIN_MAP)},
         "zip5": {"type": "string", "description": "Chicago ZIP of the area; lets a new area be scored"},
         "topics": {"type": "array", "items": {"type": "string", "enum": ["rents", "openings", "closures", "prices", "development"]}},
         "num_results": {"type": "integer"}, "days_back": {"type": "integer"}},
         "required": ["area", "cuisine"]}},
    {"name": "ingest_records",
     "description": "Store structured facts you extracted from web pages. Every record needs source_url. "
                    "Kinds: places (restaurant opened/closed), rents (asking $/sqft/year), prices (avg ticket or "
                    "entree USD), signals (news). Returns accepted / duplicates / rejected-with-reasons.",
     "input_schema": {"type": "object", "properties": {
         "kind": {"type": "string", "enum": list(KINDS)},
         "records": {"type": "array", "items": {"type": "object"},
                     "description": "fields per kind: " + json.dumps({k: list(_schema_props(k)) for k in KINDS})},
         "extractor": {"type": "string", "enum": ["agent", "manual"]}},
         "required": ["kind", "records"]}},
    {"name": "live_status", "description": "Counts of stored live records and the current model version + metrics.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "retrain_models",
     "description": "Re-download official city/federal data, retrain all models, promote only if metrics do not "
                    "degrade. Takes a few minutes.",
     "input_schema": {"type": "object", "properties": {"download": {"type": "boolean"}}}},
]
_DISPATCH = {"recommend": tool_recommend, "exa_fetch": tool_exa_fetch, "ingest_records": tool_ingest_records,
             "live_status": tool_live_status, "retrain_models": tool_retrain}


def call_tool(name, args):
    """Run one tool call; errors come back as {"error": ...} so the agent can recover."""
    try:
        return _DISPATCH[name](**(args or {}))
    except Exception as e:  # noqa: BLE001 - surfaced to the agent
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tools")
    sub.add_parser("status")
    f = sub.add_parser("fetch")
    f.add_argument("--area", required=True)
    f.add_argument("--cuisine", required=True, choices=list(FIN_MAP))
    f.add_argument("--zip5")
    f.add_argument("--topics", nargs="*")
    i = sub.add_parser("ingest")
    i.add_argument("--kind", required=True, choices=list(KINDS))
    i.add_argument("--file", required=True, help="JSON list of records")
    i.add_argument("--extractor", default="manual")
    r = sub.add_parser("recommend")
    r.add_argument("--budget", type=float, required=True)
    r.add_argument("--cuisine", required=True, choices=list(FIN_MAP))
    r.add_argument("--space", default="new")
    r.add_argument("--live", action="store_true")
    t = sub.add_parser("retrain")
    t.add_argument("--no-download", action="store_true")
    a = ap.parse_args()
    if a.cmd == "tools":
        out = TOOLS
    elif a.cmd == "status":
        out = call_tool("live_status", {})
    elif a.cmd == "fetch":
        out = call_tool("exa_fetch", {"area": a.area, "cuisine": a.cuisine, "zip5": a.zip5, "topics": a.topics})
    elif a.cmd == "ingest":
        out = call_tool("ingest_records", {"kind": a.kind, "records": json.loads(open(a.file).read()),
                                           "extractor": a.extractor})
    elif a.cmd == "recommend":
        out = call_tool("recommend", {"budget": a.budget, "cuisine": a.cuisine, "space_type": a.space,
                                      "use_live": a.live})
    else:
        out = call_tool("retrain_models", {"download": not a.no_download})
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
