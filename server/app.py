"""OpeningTable web server: built frontend + block data + live-data / retraining API.

    uvicorn server.app:app --host 0.0.0.0 --port 8000

Routes
  GET  /                       frontend (web/dist)
  GET  /data/<file>            block data exported by advantage/export_web.py (meta, overview, blocks, evidence)
  GET  /api/health             liveness (always 200 once the process is up)
  GET  /api/status             data/model state, background job, live record counts
  GET  /api/evidence/<zip>     live records for a ZIP straight from data/live (always fresh)
  GET  /api/recommend          neighborhood ranking (advantage/recommend.py), read-only, writes nothing
  GET  /api/survival           1,000-day license survival + license curve for a ZIP, optional operator / address
                               inputs (survival.SiteSurvival), read-only
  GET  /api/tools              tool schemas for an LLM agent
  POST /api/tools/<name>       run a tool (admin token, except recommend / live_status)
  POST /api/live/fetch         Exa search for a ZIP -> stored -> web data re-exported   (admin token)
  POST /api/live/ingest        store agent-extracted records -> web data re-exported  (admin token)
  POST /api/admin/retrain      download data, retrain, promote-or-rollback, export   (admin token)
  POST /api/admin/export       re-export web data only                                (admin token)

Admin calls need header  Authorization: Bearer $ADMIN_TOKEN . Without ADMIN_TOKEN set they are disabled.
On first start (no exported data) the server bootstraps in the background unless AUTO_BOOTSTRAP=0.
Everything that writes output/ (bootstrap, retrain, export, live fetch / ingest) holds the same lock; a second
writer gets HTTP 409 and can retry when /api/status shows job.state = idle.
"""
import hmac
import json
import os
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "advantage"))

from common import OUT, RAW  # noqa: E402
from live import KINDS, LiveStore  # noqa: E402

WEB_DATA = OUT / "web_data"
WEB_DIST = ROOT / "web" / "dist"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
PUBLIC_TOOLS = {"recommend", "site_survival", "live_status"}
WRITING_TOOLS = {"exa_fetch", "ingest_records"}   # re-export the web data: run under the job lock

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


@contextmanager
def _exclusive(name):
    """Synchronous request under the same lock (live fetch / ingest re-export the web data)."""
    _begin(name)
    try:
        yield
    except Exception as e:  # noqa: BLE001
        _finish(error=e)
        raise
    else:
        _finish()


def _export():
    from export_web import build
    m = build()
    return {"generatedAt": m["generatedAt"], "liveApplied": m["liveApplied"]}


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
        meta = {k: m.get(k) for k in ["generatedAt", "asOf", "snapshotId", "modelVersion", "liveApplied"]}
    reg = json.loads((OUT / "model_registry.json").read_text()) if (OUT / "model_registry.json").exists() else []
    promoted = [r for r in reg if r.get("promoted")]
    return {"data_ready": bool(meta), "data": meta,
            "job": {k: JOB[k] for k in ["state", "job", "outcome", "started_at", "finished_at", "error"]},
            "model": promoted[-1] if promoted else None, "live": LiveStore().summary(),
            "exa_configured": bool(os.environ.get("EXA_API_KEY")), "admin_enabled": bool(ADMIN_TOKEN)}


@app.get("/api/evidence/{zip5}")
def evidence(zip5: str):
    if not (zip5.isdigit() and len(zip5) == 5):
        raise HTTPException(400, "zip5 must be 5 digits")
    store, out = LiveStore(), {}
    for kind in KINDS:
        df = store.load(kind)
        if df.empty or "zip5" not in df:
            out[kind] = []
            continue
        sub = df[df.zip5 == zip5].drop(columns=[c for c in ["lat", "lon"] if c in df], errors="ignore")
        out[kind] = json.loads(sub.to_json(orient="records", date_format="iso"))
        for r in out[kind]:
            for k, v in list(r.items()):
                if isinstance(v, str) and k.endswith("_date"):
                    r[k] = v[:10]
    meta = json.loads((WEB_DATA / "meta.json").read_text()) if (WEB_DATA / "meta.json").exists() else {}
    out["rent"] = meta.get("rentByZip", {}).get(zip5)
    return out


@app.get("/api/recommend")
def recommend(budget: float = Query(...), cuisine: str = Query(...), space_type: str = "new",
              traffic_shock: float = 1.0, food_shock: float = 1.0, use_live: bool = True,
              prior_licenses: int | None = Query(None, ge=0), entity: bool | None = None):
    from agent_api import call_tool
    r = call_tool("recommend", {"budget": budget, "cuisine": cuisine, "space_type": space_type,
                                "traffic_shock": traffic_shock, "food_shock": food_shock, "use_live": use_live,
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
    if name in WRITING_TOOLS:
        with _exclusive(name):
            r = call_tool(name, args)
    else:
        r = call_tool(name, args)
    return JSONResponse(json.loads(json.dumps(r, default=str)))


@app.post("/api/live/fetch")
def live_fetch(body: dict = Body(...), authorization: str | None = Header(default=None)):
    """body: {"zip5": "60607", "cuisine": "asian", "topics": [...optional], "area": "optional"}"""
    _admin(authorization)
    from agent_api import call_tool
    with _exclusive("live_fetch"):
        r = call_tool("exa_fetch", {**body, "export": True})
    if "error" in r:
        raise HTTPException(400, r["error"])
    return JSONResponse(json.loads(json.dumps(r, default=str)))


@app.post("/api/live/ingest")
def live_ingest(body: dict = Body(...), authorization: str | None = Header(default=None)):
    """body: {"kind": "places|rents|prices|signals", "records": [...], "extractor": "agent"}"""
    _admin(authorization)
    from agent_api import call_tool
    with _exclusive("live_ingest"):
        r = call_tool("ingest_records", {"kind": body.get("kind"), "records": body.get("records", []),
                                         "extractor": body.get("extractor", "agent"), "export": True})
    if "error" in r:
        raise HTTPException(400, r["error"])
    return r


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
