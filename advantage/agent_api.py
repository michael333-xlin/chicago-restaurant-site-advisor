"""Agent interface: tools an LLM agent (or a web backend) can call, plus the self-iteration loop.

All numbers come from the downloaded datasets and the trained models; there is no live web data.
  * retrain (~1 min + ~2 min download): re-download the official datasets, rerun step1-step4, and promote the new
    models only if they are not worse than the current ones (guardrail). Scheduled weekly (.github/workflows).

CLI
    python3 advantage/agent_api.py tools                                   # print tool schemas (JSON)
    python3 advantage/agent_api.py recommend --budget 350000 --cuisine asian
    python3 advantage/agent_api.py retrain [--no-download]
    python3 advantage/agent_api.py export                                  # re-export the web block data
    python3 advantage/agent_api.py status

Python / agent
    from agent_api import TOOLS, call_tool
    call_tool("recommend", {"budget": 350000, "cuisine": "asian"})
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
from datetime import date, datetime, timezone

from common import FIN_MAP, FINANCE_DIR, OUT, ROOT

HERE = ROOT / "advantage"
VERSIONS = OUT / "versions"
REGISTRY = OUT / "model_registry.json"
ARTIFACTS = ["cuisine_classifier.pkl", "license_spans.parquet", "survival_model.pkl",
             "survival_training_table.parquet", "survival_points.parquet", "survival_defaults.json",
             "zip_panel.csv", "competitive_advantage_by_zip_cuisine.csv",
             "top3_cuisines_per_zip.csv", "top3_zips_per_cuisine.csv", "finance_by_area.csv",
             "step1_classifier_report.json", "step2_survival_report.json", "step3_report.json",
             "step4_backtest_report.json", "step2b_label_audit.json"]
STEPS = ["step1_cuisine_classifier.py", "step2_survival_model.py", "step2b_label_audit.py",
         "step4_backtest_gap.py", "step3_advantage_index.py"]   # step4 before step3: it sets gap_cap
# export_web.py runs after the promote / rollback decision, so the web data always matches the live model
# promotion guardrail: new model may not be meaningfully worse than the current one
MAX_AUC_DROP = 0.02
MAX_CLASSIFIER_ACC_DROP = 0.03
KEEP_VERSIONS = 5           # promoted snapshots kept on disk (~19 MB each)


# ------------------------------------------------------------------ self-iteration
# v2 = grouped-name classifier CV + rolling out-of-time survival validation
# v3 = the guardrail checks the DEPLOYED survival model (step2 "final_model": the model chosen by independent-
#      restaurant AUC), not the full-feature GBM
METRIC_VERSION = 3


def _metrics():
    s1 = json.loads((OUT / "step1_classifier_report.json").read_text())
    s2 = json.loads((OUT / "step2_survival_report.json").read_text())
    s4 = json.loads((OUT / "step4_backtest_report.json").read_text())
    fm = s2["final_model"]
    return {"classifier_acc": s1["accuracy_cuisine_only"],
            "survival_model": f"{fm['model']}:{fm['feature_set']}",
            "survival_auc_independent": fm["auc_independent"], "survival_auc_all": fm["auc_all"],
            "survival_brier": fm["brier_all"], "brier_constant": fm["brier_constant_all"],
            "n_openings": s2["n_openings"], "backtest_gap_p": s4["logit_gap_p_controlled"],
            "metric_version": METRIC_VERSION}


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
    """Copy a version back; each file is swapped in atomically so a reader never sees a half-copied file."""
    for a in ARTIFACTS:
        if (VERSIONS / tag / a).exists():
            tmp = OUT / f".{a}.restore"
            shutil.copy2(VERSIONS / tag / a, tmp)
            os.replace(tmp, OUT / a)


def current_version():
    promoted = [r for r in _registry() if r["promoted"]]
    return promoted[-1] if promoted else None


def retrain(download=True, force=False):
    """Refresh data, retrain, compare with the current promoted version, promote or roll back."""
    reg = _registry()
    have_outputs = all((OUT / f).exists() for f in ["step1_classifier_report.json", "step2_survival_report.json",
                                                     "step4_backtest_report.json", "survival_model.pkl"])
    if current_version() is None and have_outputs:   # bootstrap: register what is on disk as the first version
        tag = "v0_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        _snapshot(tag)
        reg.append({"version": tag, "created_at": tag[3:], "metrics": _metrics(), "promoted": True,
                    "note": "bootstrap from existing outputs"})
        REGISTRY.write_text(json.dumps(reg, indent=2))
    prev = current_version()            # None on a fresh checkout: the first trained version is promoted
    log = []
    if download:
        r = subprocess.run(["bash", str(HERE / "step0_download.sh")], cwd=ROOT, capture_output=True, text=True)
        log.append({"step": "step0_download.sh", "rc": r.returncode, "tail": r.stdout[-300:] + r.stderr[-300:]})
        if r.returncode:
            return {"promoted": False, "reason": "download failed", "log": log,
                    "current": prev["version"] if prev else None}
    for st in STEPS:
        r = subprocess.run([sys.executable, str(HERE / st)], cwd=ROOT, capture_output=True, text=True)
        log.append({"step": st, "rc": r.returncode, "tail": r.stderr[-400:] if r.returncode else ""})
        if r.returncode:
            if prev:
                _restore(prev["version"])
            return {"promoted": False, "log": log,
                    "reason": f"{st} failed" + (f"; restored {prev['version']}" if prev else "")}
    new = _metrics()
    old = prev["metrics"] if prev else {}
    checks = {"beats_constant": new["survival_brier"] <= new["brier_constant"]}
    if old.get("metric_version") == new["metric_version"]:      # only compare like with like
        checks["survival_auc"] = new["survival_auc_independent"] >= old["survival_auc_independent"] - MAX_AUC_DROP
        checks["classifier_acc"] = new["classifier_acc"] >= old["classifier_acc"] - MAX_CLASSIFIER_ACC_DROP
    else:
        checks["baseline_reset_metric_version_changed"] = True
    ok = force or all(checks.values()) or prev is None
    tag = "v" + str(len(reg)) + "_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if ok:
        _snapshot(tag)
    else:
        _restore(prev["version"])
    entry = {"version": tag, "created_at": tag.split("_", 1)[1], "metrics": new,
             "previous": prev["version"] if prev else None,
             "checks": checks, "promoted": ok, "forced": force}
    reg.append(entry)
    REGISTRY.write_text(json.dumps(reg, indent=2))
    r = subprocess.run([sys.executable, str(HERE / "export_web.py")], cwd=ROOT, capture_output=True, text=True)
    log.append({"step": "export_web.py", "rc": r.returncode, "tail": r.stderr[-400:] if r.returncode else ""})
    keep = {r["version"] for r in reg if r["promoted"]}
    keep = set(sorted(keep, key=lambda v: v.split("_", 1)[1])[-KEEP_VERSIONS:])
    for d in VERSIONS.iterdir():
        if d.is_dir() and d.name not in keep:
            shutil.rmtree(d)
    return {**entry, "log": log}


# ------------------------------------------------------------------ tools
# Engines are cached per (input files' mtimes, day): a public /api/recommend call re-reads nothing and writes
# nothing. A retrain or an export changes the mtimes, so the next call rebuilds.
_CACHE, _CACHE_LOCK = {}, threading.Lock()
_ENGINE_FILES = ["competitive_advantage_by_zip_cuisine.csv", "survival_training_table.parquet", "zip_panel.csv",
                 "survival_model.pkl", "survival_points.parquet", "survival_defaults.json"]


def _stamp():
    files = [OUT / f for f in _ENGINE_FILES] + [FINANCE_DIR / "cuisine_params.json", FINANCE_DIR / "rent_by_area.json"]
    return tuple(f.stat().st_mtime_ns if f.exists() else 0 for f in files) + (date.today().isoformat(),)


def _cached(kind, key, build):
    with _CACHE_LOCK:
        hit = _CACHE.get(kind)
        if hit and hit[0] == key:
            return hit[1]
        obj = build()
        _CACHE[kind] = (key, obj)
        return obj


def _engine():
    from recommend import Engine
    return _cached("engine", _stamp(), Engine)


def site_survival():
    from survival import SiteSurvival
    return _cached("site_survival", _stamp(), SiteSurvival)


def tool_recommend(budget, cuisine, space_type="new", traffic_shock=1.0, food_shock=1.0, top_n=5, full=False,
                   prior_licenses=None, entity=None):
    res = _engine().recommend(budget, cuisine, space_type, traffic_shock, food_shock, top_n,
                              prior_licenses=prior_licenses, entity=entity)
    if full:
        return res
    # compact view for an LLM context window
    keep = ["area", "score", "subscores", "reasons", "competition", "license_survival_1000d",
            "demographics", "stress_test", "risk", "space_comparison"]
    top = []
    for x in res["top"]:
        y = {k: x[k] for k in keep if k in x}
        f = x["finance"]
        y["finance"] = {"store": f["store"], "base": f["scenarios"]["base"], "ratios": f["ratios"],
                        "payback_months": {k: v["payback_months"] for k, v in f["scenarios"].items()},
                        "rent_psf_year": f["rent_psf_year"], "rent_source": f["rent_source"]}
        top.append(y)
    return {**{k: res[k] for k in ["inputs", "all_ranked", "excluded", "method", "sources"]}, "top": top}


def refresh_web():
    """Re-export the web block data from the current models (~1 min)."""
    from export_web import build
    m = build()
    return {"generatedAt": m["generatedAt"], "modelVersion": m["modelVersion"]}


def tool_site_survival(zip5, cuisine, prior_licenses=None, entity=None, address=None):
    return site_survival().score(str(zip5), cuisine, prior_licenses=prior_licenses, entity=entity, address=address)


def tool_model_status():
    return {"model": current_version()}


def tool_retrain(download=True):
    r = retrain(download=download)
    r.pop("log", None)
    return r


TOOLS = [
    {"name": "recommend",
     "description": "Rank Chicago neighborhoods for opening a restaurant. Areas that do not fit the budget are "
                    "excluded; the rest are ranked by supply gap, base-case payback and profit when traffic drops 30%. "
                    "Also returns store size, monthly P&L, warnings, competition, demographics and a separate "
                    "1,000-day license survival estimate (not part of the score). All numbers carry sources.",
     "input_schema": {"type": "object", "properties": {
         "budget": {"type": "number", "description": "total budget in USD"},
         "cuisine": {"type": "string", "enum": list(FIN_MAP)},
         "space_type": {"type": "string", "enum": ["new", "second_gen"], "description": "new build-out or take over an existing restaurant space"},
         "traffic_shock": {"type": "number", "description": "1.0 = normal, 0.7 = 30% fewer customers"},
         "food_shock": {"type": "number", "description": "1.0 = normal, 1.15 = food costs +15%"},
         "top_n": {"type": "integer"},
         "prior_licenses": {"type": "integer", "description": "optional: Chicago food licenses the operator held before "
                                                              "(re-scores the survival estimate; omitted = ZIP average)"},
         "entity": {"type": "boolean", "description": "optional: the business is registered as a company (LLC/Inc)"}},
         "required": ["budget", "cuisine"]}},
    {"name": "site_survival",
     "description": "1,000-day license survival estimate (rolling out-of-time AUC ~0.61 for independents) and the "
                    "month-by-month probability that the license is still active, for a new independent dine-in "
                    "restaurant in one ZIP. Optional operator / address inputs replace the ZIP averages.",
     "input_schema": {"type": "object", "properties": {
         "zip5": {"type": "string"}, "cuisine": {"type": "string", "enum": list(FIN_MAP)},
         "prior_licenses": {"type": "integer", "description": "Chicago food licenses the operator held before"},
         "entity": {"type": "boolean", "description": "registered as a company (LLC/Inc/Corp)"},
         "address": {"type": "string", "description": "street address of the site, e.g. '2121 N Clark St'"}},
         "required": ["zip5", "cuisine"]}},
    {"name": "model_status", "description": "The current promoted model version and its validation metrics.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "retrain_models",
     "description": "Re-download official city/federal data, retrain all models, promote only if metrics do not "
                    "degrade. Takes a few minutes.",
     "input_schema": {"type": "object", "properties": {"download": {"type": "boolean"}}}},
]
_DISPATCH = {"recommend": tool_recommend, "site_survival": tool_site_survival, "model_status": tool_model_status,
             "retrain_models": tool_retrain}


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
    sub.add_parser("export", help="re-export the web block data")
    r = sub.add_parser("recommend")
    r.add_argument("--budget", type=float, required=True)
    r.add_argument("--cuisine", required=True, choices=list(FIN_MAP))
    r.add_argument("--space", default="new")
    t = sub.add_parser("retrain")
    t.add_argument("--no-download", action="store_true")
    a = ap.parse_args()
    if a.cmd == "tools":
        out = TOOLS
    elif a.cmd == "status":
        out = call_tool("model_status", {})
    elif a.cmd == "export":
        out = refresh_web()
    elif a.cmd == "recommend":
        out = call_tool("recommend", {"budget": a.budget, "cuisine": a.cuisine, "space_type": a.space})
    else:
        out = call_tool("retrain_models", {"download": not a.no_download})
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
