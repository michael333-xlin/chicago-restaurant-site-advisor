"""OpeningTable web server: built frontend + block data + model API + plain-English report writer.

    uvicorn server.app:app --host 0.0.0.0 --port 8000

Routes
  GET  /                       frontend (web/dist)
  GET  /data/<file>            block data exported by advantage/export_web.py (meta, overview, blocks)
  GET  /api/health             liveness (always 200 once the process is up)
  GET  /api/status             data/model state, background job, whether the report writer is configured
  GET  /api/recommend          neighborhood ranking (advantage/recommend.py), read-only, writes nothing
  GET  /api/survival           1,000-day license survival + license curve for a ZIP, optional operator / address
                               inputs (survival.SiteSurvival), read-only
  POST /api/report             plain-English report written by DeepSeek from one analysis' model outputs
                               (advantage/narrative.py); every number is checked against those outputs
  GET  /api/tools              tool schemas for an LLM agent
  POST /api/tools/<name>       run a tool (admin token, except recommend / site_survival / model_status)
  POST /api/admin/retrain      download data, retrain, promote-or-rollback, export   (admin token)
  POST /api/admin/export       re-export web data only                                (admin token)

All numbers come from the downloaded datasets and the trained models (no live web data).
Admin calls need header  Authorization: Bearer $ADMIN_TOKEN . Without ADMIN_TOKEN set they are disabled.
The report writer needs DEEPSEEK_API_KEY; without it /api/report returns 503.
On first start (no exported data) the server bootstraps in the background unless AUTO_BOOTSTRAP=0.
Everything that writes output/ (bootstrap, retrain, export) holds the same lock; a second writer gets HTTP 409
and can retry when /api/status shows job.state = idle.
"""
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "advantage"))

from common import OUT, RAW  # noqa: E402

WEB_DATA = OUT / "web_data"
WEB_DIST = ROOT / "web" / "dist"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
PUBLIC_TOOLS = {"recommend", "site_survival", "model_status"}
REPORT_MAX_BYTES = 80_000        # one analysis' model outputs are ~10-20 KB
REPORT_CACHE_SIZE = 200          # identical analyses reuse the written report instead of calling DeepSeek again

# ------------------------------------------------------------------ jobs that write output/ (one at a time)
# job.state: idle | running | error.  job.outcome of the last job: promoted | rolled_back | done | failed
_lock = threading.Lock()
JOB = {"state": "idle", "job": None, "outcome": None, "started_at": None, "finished_at": None, "result": None,
       "error": None}


def _begin(name):
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, f"another job is running: {JOB['job']}; retry when /api/status shows idle")
    JOB.update(state="running", job=name, outcome=None, started_at=time.time(), finished_at=None, result=None,
               error=None)


def _finish(result=None, error=None):
    if error is None:
        JOB.update(state="idle", result=result, outcome=(result or {}).get("outcome", "done"))
    else:
        JOB.update(state="error", outcome="failed", error=f"{type(error).__name__}: {error}",
                   result=traceback.format_exc()[-2000:])
    JOB["finished_at"] = time.time()
    _lock.release()


def _run(name, fn):
    """Background job under the lock."""
    _begin(name)

    def target():
        try:
            r = fn()
        except Exception as e:  # noqa: BLE001 - reported through /api/status
            _finish(error=e)
        else:
            _finish(result=r)

    threading.Thread(target=target, daemon=True).start()
    return {"started": name}


def _export():
    from export_web import build
    m = build()
    return {"generatedAt": m["generatedAt"], "modelVersion": m["modelVersion"]}


def _retrain(download):
    """A rollback (new model failed the guardrail, previous version restored) is a normal outcome, not an error.
    A failed download or pipeline step is an error."""
    from agent_api import retrain
    r = retrain(download=download)
    r.pop("log", None)
    if r.get("reason"):
        raise RuntimeError(f"retrain failed: {r['reason']}")
    if not (WEB_DATA / "meta.json").exists():   # retrain normally exports as its last step
        _export()
    return {**r, "outcome": "promoted" if r.get("promoted") else "rolled_back"}


def _bootstrap():
    """First start: download data if missing, train if no model, then export."""
    have_raw = (RAW / "licenses").exists() and any((RAW / "licenses").glob("p_*.csv"))
    have_model = (OUT / "survival_model.pkl").exists() and (OUT / "license_spans.parquet").exists()
    if not have_model:
        return _retrain(download=not have_raw)
    return _export()


@asynccontextmanager
async def lifespan(_app):
    if os.environ.get("AUTO_BOOTSTRAP", "1") != "0" and not (WEB_DATA / "meta.json").exists():
        _run("bootstrap", _bootstrap)
    yield


app = FastAPI(title="OpeningTable", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _admin(authorization):
    if not ADMIN_TOKEN:
        raise HTTPException(403, "admin API disabled: set ADMIN_TOKEN on the server")
    if not hmac.compare_digest((authorization or "").encode(), f"Bearer {ADMIN_TOKEN}".encode()):
        raise HTTPException(401, "bad or missing admin token")


# ------------------------------------------------------------------ API
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/status")
def status():
    meta = {}
    if (WEB_DATA / "meta.json").exists():
        m = json.loads((WEB_DATA / "meta.json").read_text())
        meta = {k: m.get(k) for k in ["generatedAt", "asOf", "snapshotId", "modelVersion"]}
    reg = json.loads((OUT / "model_registry.json").read_text()) if (OUT / "model_registry.json").exists() else []
    promoted = [r for r in reg if r.get("promoted")]
    return {"data_ready": bool(meta), "data": meta,
            "job": {k: JOB[k] for k in ["state", "job", "outcome", "started_at", "finished_at", "error"]},
            "model": promoted[-1] if promoted else None,
            "report_writer_configured": bool(os.environ.get("DEEPSEEK_API_KEY")), "admin_enabled": bool(ADMIN_TOKEN)}


@app.get("/api/recommend")
def recommend(budget: float = Query(...), cuisine: str = Query(...), space_type: str = "new",
              traffic_shock: float = 1.0, food_shock: float = 1.0,
              prior_licenses: int | None = Query(None, ge=0), entity: bool | None = None):
    from agent_api import call_tool
    r = call_tool("recommend", {"budget": budget, "cuisine": cuisine, "space_type": space_type,
                                "traffic_shock": traffic_shock, "food_shock": food_shock,
                                "prior_licenses": prior_licenses, "entity": entity})
    if "error" in r:
        raise HTTPException(400, r["error"])
    return JSONResponse(json.loads(json.dumps(r, default=float)))


@app.get("/api/survival")
def survival(zip5: str = Query(...), cuisine: str = Query(...), prior_licenses: int | None = Query(None, ge=0),
             entity: bool | None = None, address: str | None = Query(None, max_length=120)):
    """Optional inputs replace the ZIP averages of recent independent openings; omitted ones keep them."""
    if not (zip5.isdigit() and len(zip5) == 5):
        raise HTTPException(400, "zip5 must be 5 digits")
    from agent_api import call_tool
    r = call_tool("site_survival", {"zip5": zip5, "cuisine": cuisine, "prior_licenses": prior_licenses,
                                    "entity": entity, "address": (address or "").strip() or None})
    if "error" in r:
        raise HTTPException(400, r["error"])
    return JSONResponse(json.loads(json.dumps(r, default=float)))


_report_cache = {}
_report_cache_lock = threading.Lock()


@app.post("/api/report")
def report(body: dict = Body(...)):
    """body: {"payload": {...}} built by the web app from one analysis (web/src/model/narrativePayload.ts).
    DeepSeek only writes the text; numbers it uses that are not in the payload come back in unverified_numbers."""
    payload = body.get("payload")
    if not isinstance(payload, dict) or not payload:
        raise HTTPException(400, "body must be {\"payload\": {...}}")
    raw = json.dumps(payload, sort_keys=True)
    if len(raw.encode()) > REPORT_MAX_BYTES:
        raise HTTPException(413, f"payload larger than {REPORT_MAX_BYTES} bytes")
    if not os.environ.get("DEEPSEEK_API_KEY"):
        raise HTTPException(503, "report writer not configured: set DEEPSEEK_API_KEY on the server")
    key = hashlib.sha256(raw.encode()).hexdigest()
    with _report_cache_lock:
        hit = _report_cache.get(key)
    if hit:
        return {**hit, "cached": True}
    from narrative import NarrativeError, write_report
    try:
        r = write_report(payload)
    except NarrativeError as e:
        raise HTTPException(502, str(e))
    r["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with _report_cache_lock:
        if len(_report_cache) >= REPORT_CACHE_SIZE:
            _report_cache.pop(next(iter(_report_cache)))
        _report_cache[key] = r
    return {**r, "cached": False}


@app.get("/api/tools")
def tools():
    from agent_api import TOOLS
    return TOOLS


@app.post("/api/tools/{name}")
def run_tool(name: str, args: dict = Body(default={}), authorization: str | None = Header(default=None)):
    from agent_api import _DISPATCH, call_tool
    if name not in _DISPATCH:
        raise HTTPException(404, f"unknown tool {name}")
    if name not in PUBLIC_TOOLS:
        _admin(authorization)
    if name == "retrain_models":
        return _run("retrain", lambda: _retrain(bool(args.get("download", True))))
    r = call_tool(name, args)
    return JSONResponse(json.loads(json.dumps(r, default=str)))


@app.post("/api/admin/retrain")
def admin_retrain(body: dict = Body(default={}), authorization: str | None = Header(default=None)):
    _admin(authorization)
    return _run("retrain", lambda: _retrain(bool(body.get("download", True))))


@app.post("/api/admin/export")
def admin_export(authorization: str | None = Header(default=None)):
    _admin(authorization)
    return _run("export", _export)


# ------------------------------------------------------------------ data + frontend
@app.get("/data/{path:path}")
def data_file(path: str):
    base = WEB_DATA.resolve()
    f = (WEB_DATA / path).resolve()
    if base not in f.parents or not f.is_file():
        if not (WEB_DATA / "meta.json").exists():
            raise HTTPException(503, "data is being prepared — check /api/status")
        raise HTTPException(404, "not found")
    return FileResponse(f, media_type="application/json", headers={"Cache-Control": "no-cache"})


if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
else:
    @app.get("/")
    def no_frontend():
        return {"message": "frontend not built: cd web && npm ci && npm run build", "status": "/api/status"}
