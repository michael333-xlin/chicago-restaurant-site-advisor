# OpeningTable: Chicago Restaurant Site Advisor

Enter a budget and a restaurant type. For a given Chicago ZIP, OpeningTable estimates store size, startup cost, monthly P&L, payback period and risk for each block (H3 cell), with data sources attached.

This document covers only **how to run, deploy, and fetch new data**. For model methodology and validation results, see [advantage/README.md](advantage/README.md). For product design, see [docs/](docs/).

## 1. Repository layout

```
├── web/                 Frontend (React + Vite + deck.gl). The financial model and Monte Carlo simulation run in the browser
├── server/app.py        Backend (FastAPI): serves the frontend, /data block data and /api endpoints
├── advantage/           Python data pipeline and models: download, training, block data export, live data, self-iteration
├── finance/             Financial parameters, per-neighborhood rent research, neighborhood boundaries
├── data/seed/           Overture restaurant snapshot (required on first start)
├── docs/                Product design docs, data source handbook
├── Dockerfile           One image containing the frontend, pipeline and backend
├── render.yaml          Render one-click deploy config
├── requirements.txt     Python dependencies (pinned versions)
└── .github/workflows/weekly-refresh.yml   Weekly automatic retraining
```

At runtime, two directories are created on the server's disk. They are not committed to git:
- `data/`: downloaded raw data (about 100 MB) and live records in `data/live/`
- `output/`: model files, plus the block data for the frontend in `output/web_data/` (about 33 MB, gzip-compressed in transit)

## 2. Running locally

Requires Python 3.11–3.14 and Node 22.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
bash advantage/step0_download.sh
```

```bash
.venv/bin/python advantage/agent_api.py retrain --no-download
```

```bash
cd web && npm ci && npm run build && cd ..
```

```bash
ADMIN_TOKEN=devtoken .venv/bin/python -m uvicorn server.app:app --port 8000
```

- The first command sets up the Python environment.
- The second downloads public data. It takes about 3 minutes and needs no keys.
- The third trains all models and exports block data. It takes about 1.5 minutes, with peak memory around 1.4 GB.
- The fourth builds the frontend.
- The fifth starts the server.

Open http://localhost:8000 to use it.

When working on frontend code, run `cd web && npm run dev` in a separate terminal and open http://localhost:5180. The dev server proxies `/api` and `/data` to port 8000.

The shortcut: skip the second and third commands and just start the server. When it finds no data, it downloads, trains and exports in the background. The frontend shows "Preparing data" and switches to the normal page automatically after about 5 minutes.

## 3. Deploying to Render (recommended)

Render runs Docker with a persistent disk, so data and models survive redeploys.

1. Push the repo to GitHub (`main` branch).
2. On Render, click **New → Blueprint** and pick the repo. `render.yaml` creates the `plategap` service with:
   - a **Standard (2 GB RAM)** instance (training needs about 1.4 GB, so 512 MB fails)
   - a 5 GB disk at `/var/plategap`
   - an auto-generated `ADMIN_TOKEN`
3. Under **Environment**, add `EXA_API_KEY`.
4. Open the service URL. The first start takes 3–5 minutes to download data and train. Check `https://<your-domain>/api/status` and wait for `"data_ready": true`.
5. For weekly retraining, add two GitHub secrets under **Settings → Secrets and variables → Actions**:
   - `PLATEGAP_URL`: the service URL, e.g. `https://plategap.onrender.com`
   - `PLATEGAP_ADMIN_TOKEN`: the `ADMIN_TOKEN` value from Render

The names still say `plategap` (the project's old name). Renaming them would break existing deployments.

> **Cost:** the Standard instance and disk are paid. Delete both in Render after the competition.

**Other platforms:** anything that runs Docker with a mounted volume works (Railway, Fly.io, a cloud VM):

```bash
docker build -t plategap .
```

```bash
docker run -p 8000:8000 -v plategap-data:/var/plategap -e ADMIN_TOKEN=replace-with-a-random-string -e EXA_API_KEY=your-key plategap
```

The frontend's basemap comes from CARTO (basemaps.cartocdn.com), so the browser needs internet access.

## 4. Fetching new data (Exa)

### 4.1 Fetch one ZIP with one command

With `EXA_API_KEY` set on the server:

```bash
curl -X POST https://<your-domain>/api/live/fetch -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"zip5": "60607", "cuisine": "asian"}'
```

Local CLI equivalent:

```bash
EXA_API_KEY=... .venv/bin/python advantage/agent_api.py fetch --zip5 60607 --cuisine asian
```

What happens, in order:
1. Exa searches the ZIP on 5 topics: retail listings and rents, restaurant openings, closures, menu prices, and development projects. The neighborhood name is looked up from the ZIP automatically, or you can set it with the `area` field. Exa bills per search, about 5 per ZIP.
2. Raw web results are saved to `data/live/exa_raw/`.
3. Rules extract two kinds of information and store them: **rents** (patterns like `$xx/SF` and `$x per sq ft per month`; monthly rents are converted to annual) and **news**. Rule-extracted records get a confidence of 0.4.
4. Block data is re-exported automatically, in about 10 seconds. Then, in the frontend:
   - The **Evidence** section of the site report lists these records, each with a link to the source.
   - **Rule-extracted rents are shown as evidence only and do not replace the rent**: `$xx/SF` also matches sale prices and office listings. Replacing a ZIP's rent requires at least 3 rent records imported by an agent or a person (see 4.2); price data follows the same rule.
5. The response includes the page text for each topic, so an agent can extract what the rules cannot (see 4.2).

### 4.2 Importing structured data extracted by an agent

Openings, closures and menu prices require reading and understanding the page, which rules cannot do. An agent (LLM) reads the text returned in 4.1, turns it into records, and imports them:

```bash
curl -X POST https://<your-domain>/api/live/ingest -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d @records.json
```

The format of `records.json` is below. Each request imports one kind of record, and **every record must have a `source_url`**:

```json
{"kind": "places", "extractor": "agent", "records": [
  {"name": "Example Noodle Bar", "status": "open", "event_date": "2026-10-20", "zip5": "60607",
   "cuisine": "asian", "source_url": "https://..."}
]}
```

| kind | Required fields | Effect after import |
|---|---|---|
| `places` | `name`, `status` (`open` or `closed`), `event_date`, `source_url`, plus `zip5` or `lat`+`lon` | New openings are added to the supply count (skipped if a place with the same name and ZIP is already in the snapshot); closures are subtracted. Each block's "expected vs. actual" updates accordingly. If no cuisine is given, it is inferred from the name |
| `rents` | `rent_psf_year` (USD per sq ft per year), `observed_date`, `source_url`, plus `zip5` or `area` | When a ZIP has at least 3 agent/manual records, its rent is replaced by their median; with fewer than 3, they only appear in Evidence |
| `prices` | `avg_ticket_usd` or `avg_entree_usd`, `observed_date`, `source_url` | Shown in Evidence, and used as the average ticket in `/api/recommend` |
| `signals` | `title`, `published_date`, `source_url` | Shown in Evidence; not used in calculations |

The response includes `accepted` (number imported), `duplicates` (number skipped as duplicates) and `rejected` (rejected records with reasons). Block data is re-exported automatically after import as well. CLI equivalent:

```bash
.venv/bin/python advantage/agent_api.py ingest --kind places --file places.json
```

(Here `--file` contains only the `records` array.)

### 4.3 Tool endpoints for agents

- `GET /api/tools`: returns JSON schemas for 6 tools, compatible with OpenAI/Anthropic tool-calling definitions. The tools are `recommend`, `site_survival`, `exa_fetch`, `ingest_records`, `live_status` and `retrain_models`.
- `POST /api/tools/<name>`: runs a tool; the request body is its arguments. `recommend`, `site_survival` and `live_status` need no token; the rest require `ADMIN_TOKEN`.

A typical agent loop: `exa_fetch` → read the text and extract records → `ingest_records` → get updated numbers from the frontend or `recommend` → write the report with sources.

## 5. Self-iteration: periodic retraining

```bash
curl -X POST https://<your-domain>/api/admin/retrain -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"download": true}'
```

This request runs the following in the background: re-download official Chicago data (licenses, population, LODES, CTA, etc.) → rerun all models → **promote the new model only if it is no worse than the current one**, otherwise roll back automatically → re-export block data.

The check applies to the **survival model actually in production** (the model step2 selects by independent-restaurant AUC, `final_model` in the report): its out-of-time Brier score must beat the constant baseline, and under the same metrics version, its independent-restaurant AUC may drop by no more than 0.02 and classifier accuracy by no more than 0.03. A rollback is a normal outcome: `job.outcome` in `/api/status` shows `rolled_back` (or `promoted` when promoted). Only a failed download or a failed step shows `error`.

`.github/workflows/weekly-refresh.yml` sends this request automatically every Monday; you can also trigger it manually from the GitHub Actions page. Versions are recorded in `output/model_registry.json`, and the 5 most recently promoted versions are kept on disk.

To reapply live records to block data without retraining:

```bash
curl -X POST https://<your-domain>/api/admin/export -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 6. API overview

| Method and path | Token required | Description |
|---|---|---|
| `GET /` | No | Frontend page |
| `GET /data/meta.json`, `/data/overview.json`, `/data/blocks/<zip>.json`, `/data/evidence/<zip>.json` | No | Block data read by the frontend |
| `GET /api/health` | No | Liveness check |
| `GET /api/status` | No | Whether data is ready, background job, model version, live record counts, whether the Exa key is configured |
| `GET /api/evidence/<zip>` | No | Live records for a ZIP (read directly, always current) |
| `GET /api/recommend?budget=350000&cuisine=asian` | No | Ranks neighborhoods (the 7 with rent research, plus ZIPs with live rents). Optional `prior_licenses` and `entity` recompute the survival estimate. Read-only; does not write to disk |
| `GET /api/survival?zip5=60614&cuisine=italian` | No | 1,000-day license survival estimate for a new independent restaurant in a ZIP, plus the monthly probability that the license is still active. Optional `prior_licenses` (number of Chicago food licenses previously held), `entity` (whether incorporated), `address` (a specific address, to look up its license history). Omitted fields use the mean of recent independent openings in that ZIP |
| `GET /api/tools`, `POST /api/tools/<name>` | Some | Agent tools |
| `POST /api/live/fetch` | Yes | Fetch one ZIP via Exa |
| `POST /api/live/ingest` | Yes | Import structured records |
| `POST /api/admin/retrain` | Yes | Re-download data and retrain |
| `POST /api/admin/export` | Yes | Re-export block data only |
| `GET /api/docs` | No | Auto-generated API docs |

Endpoints that require a token need the header `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` is not set on the server, these endpoints are all disabled.

Operations that write to `output/` (first-start data preparation, retraining, export, live fetch and ingest) share a single lock, so only one runs at a time. When the lock is held, they return HTTP 409; wait until `job.state` in `/api/status` returns to `idle`, then retry.

## 7. Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_TOKEN` | Empty (admin endpoints disabled) | Password for admin endpoints |
| `EXA_API_KEY` | Empty | Exa search; without it, `/api/live/fetch` returns 400 |
| `DATA_DIR` | `./data` | Location of raw data and live records; point to the persistent disk when deployed |
| `OUTPUT_DIR` | `./output` | Location of models and exported data; point to the persistent disk when deployed |
| `AUTO_BOOTSTRAP` | `1` | Whether to download and train automatically when no data exists; set to `0` to disable |
| `AS_OF` | Date of the downloaded data | The "today" used for estimates; usually leave unset |
| `PORT` | `8000` | Listening port inside Docker (set automatically by Render) |
| `VITE_DATA_BASE`, `VITE_API_BASE` | `/data`, `/api` | Only needed when the frontend and backend are deployed separately (set when building the frontend) |

## 8. FAQ

- **The page stays on "Preparing data"**: the first start is still downloading and training. Check `/api/status`: if `job.state` is `error`, `job.error` has the reason. The most common cause is insufficient memory; at least 2 GB is required.
- **`/api/live/fetch` returns `EXA_API_KEY is not set`**: set this environment variable on the server and restart the service.
- **The frontend doesn't change after a fetch**: refresh the page; the frontend caches ZIPs it has already loaded. Also, rule-extracted rents do not replace the rent; at least 3 agent/manual records are needed (see 4.1).
- **Ingest or fetch returns 409**: a retrain or export is in progress; retry later.
- **The basemap is black**: the browser cannot reach basemaps.cartocdn.com. The hexagon data layer is unaffected.

## 9. Data not yet integrated

- **Liquor restriction areas**: the Chicago Data Portal's dry precincts (Liquor Moratorium Districts – Dry Precincts, y49e-jumb) are integrated. When a liquor license is needed, blocks whose centroid falls in a dry precinct are excluded. This is historical data from 2011 and precinct boundaries have changed since, so verify with BACP before signing a lease. Tavern-restricted street segments do not apply to restaurants per the official guidance, so they are not used.
- **Hotel rooms, student share**: no data; removed from the customer profile.
- **Rent**: ZIP level only. 7 neighborhoods have team-researched rents; other ZIPs use the median of those 7 until live listings are fetched, and this is flagged under risks.
- **Average ticket in the frontend**: uses sourced benchmark values from the parameter table (full service $24 / $32 / $50 from public chain 10-Ks; no public per-person spend was found for quick service and fast casual, so these are marked "no public source"). Live menu prices only appear in Evidence and do not yet replace these values automatically.

### Sources for financial parameters

All parameters of the in-browser financial model (41 for full service with a liquor license, slightly fewer for other formats) come from `web/src/model/benchmarks.json`. Each records its source (publisher, title, link, date, and the raw figure read from the page) and how its triangular distribution [low, most likely, high] was derived. The Assumptions table on the site shows each item's status:

- **Sourced** (14 items): e.g. Chicago minimum wage, BLS OEWS May 2025 wage percentiles for the Chicago metro area (pulled via API), IRS and Illinois unemployment insurance employer tax rates, Chicago BACP license and liquor license fees, per-occupant area from the Chicago Building Code, card processing fees, and delivery platform commissions.
- **Partially sourced** (20 items): a cited figure plus a documented derivation, e.g. revenue, build-out and equipment costs (Item 7 of franchise disclosure documents), ramp-up period, delivery share, NNN.
- **No public source** (7 items): first-month revenue ratio, table turns, occupancy rate, maintenance cost, refurbishment ratio for second-generation equipment, traffic volatility, and the bounds on demand adjustment. Original values are kept and flagged in the table.

Compared with the earlier placeholder values, the sourced figures make opening costs noticeably higher and ramp-up longer, so payback takes longer. For example, for 60614, Italian full service, with a budget cap of $900K, P50 payback goes from 27 months to over 72 months. The biggest drivers are the ramp-up period (6 / 18 / 36 months, taken from the threshold at which chain stores enter same-store sales, which is only a proxy) and the cost of refurbishing a second-generation space ($90 / $175 / $300 per sq ft).

A few constants in the model structure are not in the parameter table and have no public source either: revenue share by daypart (`DAYPART_SHARE`), daypart durations, the ±10% ticket adjustment by income quantile, staffing ratios based on daily traffic, and the square-root scaling of equipment cost with floor area.

### Data sources

- Overture Maps places (CDLA-Permissive-2.0)
- Chicago Data Portal: Business Licenses r5kz-chrr, Population Counts 85cm-7uqa, CTA 'L' ridership 5neh-572f and stations 8pix-ypme, Food Inspections 4ijn-s7e5, ZIP boundaries unjd-c2ca, dry precincts y49e-jumb
- US Census LEHD LODES8 (WAC and RAC)

See [docs/data_sources_chicago.md](docs/data_sources_chicago.md) for details.
