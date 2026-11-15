OpeningTable: Chicago Restaurant Site Advisor

OpeningTable helps independent restaurants pick a site in Chicago.

We download historical public data (Chicago business licenses, food inspections, population, LODES employment, CTA ridership, and an Overture restaurant snapshot), clean it and align it in time, and use it to train three models: a cuisine classifier, a license survival model and a supply gap model. The results are shown on a map. Enter a budget and a restaurant type, pick a ZIP, and each block (H3 cell) shows store size, startup cost, monthly P&L, payback period and risk, with data sources attached.

Every number comes from the downloaded public data and the trained models. Each site report opens with a plain-English report written by DeepSeek, which explains those numbers and never creates them.

This document covers how to run and deploy the project. For model methodology and validation results, see advantage/README.md. For product design, see docs/.

Quick start

Try it in your browser (free, nothing to install):

Open in GitHub Codespaces

Click the button, then Create codespace. Setup installs everything and starts the server by itself; the site opens in a new tab. The first start shows "Preparing data" for about 5 minutes while it downloads public data and trains the models. Details are in Running in GitHub Codespaces.

Deploy a permanent site:

Deploy to Render

This creates the service from render.yaml. Paste your DEEPSEEK_API_KEY when asked (optional). The Standard instance and disk are paid; see section 3.

1. Repository layout
├── web/                 Frontend (React + Vite + deck.gl). The financial model and Monte Carlo simulation run in the browser
├── server/app.py        Backend (FastAPI): serves the frontend, /data block data and /api endpoints
├── advantage/           Python data pipeline and models: download, training, block data export, plain-English report writer (narrative.py), self-iteration
├── finance/             Financial parameters, per-neighborhood rent research, neighborhood boundaries
├── data/seed/           Overture restaurant snapshot (required on first start)
├── docs/                Product design docs, data source handbook
├── .devcontainer/       GitHub Codespaces setup (installs dependencies and starts the server)
├── Dockerfile           One image containing the frontend, pipeline and backend
├── render.yaml          Render one-click deploy config
├── requirements.txt     Python dependencies (pinned versions)
└── .github/workflows/weekly-refresh.yml   Weekly automatic retraining

At runtime, two directories are created on the server's disk. They are not committed to git:

data/: downloaded raw data (about 100 MB)
output/: model files, plus the block data for the frontend in output/web_data/ (about 33 MB, gzip-compressed in transit)
2. Running locally

Requires Python 3.11–3.14 and Node 22.

bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
bash
bash advantage/step0_download.sh
bash
.venv/bin/python advantage/agent_api.py retrain --no-download
bash
cd web && npm ci && npm run build && cd ..
bash
ADMIN_TOKEN=devtoken .venv/bin/python -m uvicorn server.app:app --port 8000
The first command sets up the Python environment.
The second downloads public data. It takes about 3 minutes and needs no keys.
The third trains all models and exports block data. It takes about 1.5 minutes, with peak memory around 1.4 GB.
The fourth builds the frontend.
The fifth starts the server.

Open http://localhost:8000 to use it.

When working on frontend code, run cd web && npm run dev in a separate terminal and open http://localhost:5180. The dev server proxies /api and /data to port 8000.

The shortcut: skip the second and third commands and just start the server. When it finds no data, it downloads, trains and exports in the background. The frontend shows "Preparing data" and switches to the normal page automatically after about 5 minutes.

Running in GitHub Codespaces (free, nothing to install)

Codespaces runs the project on a cloud machine in your browser, so you don't need Python or Node on your own computer. Personal GitHub accounts get a free monthly quota.

Open https://codespaces.new/michael333-xlin/chicago-restaurant-site-advisor (or click the button in Quick start).
Optional: on the creation page, fill in DEEPSEEK_API_KEY to turn on the plain-English report (section 4). Without it, everything else works. You can also add it later under GitHub Settings → Codespaces → Secrets, then rebuild the codespace.
Click Create codespace and wait. The first build takes a few minutes: .devcontainer/devcontainer.json installs Python 3.13, Node 22 and all dependencies, builds the frontend, and starts the server.
The site opens in a new browser tab. If it doesn't, open the Ports tab and click the globe icon next to port 8000.

On first start the page shows "Preparing data" for about 5 minutes while the server downloads data and trains the models, then it switches to the normal page. The server runs in a terminal inside the codespace; don't close that terminal.

Port 8000 is private by default: only you can open it. To share it, right-click port 8000 in the Ports tab and set Port Visibility → Public. The admin endpoints stay off in Codespaces because ADMIN_TOKEN is not set; to retrain from there, stop the server and start it again with ADMIN_TOKEN=your-token in front of the command. When you are done, stop the codespace (Codespaces menu → Stop Current Codespace) so it doesn't use up your quota.

3. Deploying to Render (recommended)

Render runs Docker with a persistent disk, so data and models survive redeploys.

Push the repo to GitHub (main branch).
On Render, click New → Blueprint and pick the repo. render.yaml creates the plategap service with:
a Standard (2 GB RAM) instance (training needs about 1.4 GB, so 512 MB fails)
a 5 GB disk at /var/plategap
an auto-generated ADMIN_TOKEN
Under Environment, add DEEPSEEK_API_KEY for the plain-English report (section 4). Without it the rest of the app works and that section shows why it is missing.
Open the service URL. The first start takes 3–5 minutes to download data and train. Check https://<your-domain>/api/status and wait for "data_ready": true.
For weekly retraining, add two GitHub secrets under Settings → Secrets and variables → Actions:
PLATEGAP_URL: the service URL, e.g. https://plategap.onrender.com
PLATEGAP_ADMIN_TOKEN: the ADMIN_TOKEN value from Render

The names still say plategap (the project's old name). Renaming them would break existing deployments.

Cost: the Standard instance and disk are paid. Delete both in Render after the competition.

Other platforms: anything that runs Docker with a mounted volume works (Railway, Fly.io, a cloud VM):

bash
docker build -t plategap .
bash
docker run -p 8000:8000 -v plategap-data:/var/plategap -e ADMIN_TOKEN=replace-with-a-random-string plategap

To enable the plain-English report (section 4), also pass -e DEEPSEEK_API_KEY=your-key.

The frontend's basemap comes from CARTO (basemaps.cartocdn.com), so the browser needs internet access.

4. Plain-English report (DeepSeek)

When you open a site report, the web app packs this analysis' model results into one structured object (web/src/model/narrativePayload.ts): your request, each candidate site's startup cost, payback months, monthly P&L, competition, customers, risks and sensitivity, the survival estimate, every financial benchmark with its range and source status, and the data sources and limits. The server adds 45 Chicago reference facts, quotes from official or citable pages already researched in benchmarks.json (City of Chicago BACP retail food and liquor license fees and the pre-opening health inspection, IRS and Illinois IDES employer tax rates, deposit and cash-reserve conventions, NNN charges, delivery and card fees), each with its publisher and link. It then sends everything to DeepSeek (advantage/narrative.py, model deepseek-flash, thinking disabled, JSON output).

The system prompt contains no numbers. It holds a field guide to the payload, a restaurant-economics primer (net cash flow and prime cost, ramp-up, cash reserve, second-generation space vs. vacant shell, how to read the supply gap and competition, NNN leases, license renewal vs. still operating, tailoring to the owner's risk appetite), number discipline (only numbers from the payload, rounding allowed, no arithmetic, state both amounts instead of a difference), writing rules, a section-by-section brief and a self-check list.

The report, shown as Plain-English report at the top of the site report:

headline, bottom line, your request restated, and "Is this a fit for you?";
three charts drawn by the web app from the same results (cost to open, time to pay back, where each month's sales go), each with a one- or two-sentence takeaway from DeepSeek, plus a table view;
site by site, how the sites compare, and what would change the answer;
risk cards (level, why it matters, what to do);
next steps, questions to ask before signing, a Chicago checklist for licenses, permits, payroll and the lease, how to read the numbers, data and limits, and the sources behind the checklist.

Quality control: after the first draft the server checks the structure (every section present, one card per site with the site's exact name, valid risk levels, list lengths) and traces every number in the text to the payload at its own rounding. If anything fails, DeepSeek gets the list of problems and revises once (one report takes about 15–35 seconds). Anything that still fails is listed at the bottom of the report. Identical analyses reuse the written report (the server keeps the last 200 in memory).

Locally, put the key in the environment:

bash
ADMIN_TOKEN=devtoken DEEPSEEK_API_KEY=your-key .venv/bin/python -m uvicorn server.app:app --port 8000

Without DEEPSEEK_API_KEY, /api/report returns 503 and only that section shows the reason. /api/report needs no token, so on a public deployment anyone can trigger DeepSeek calls (which cost money); put access control in front of it if needed.

Tool endpoints for agents
GET /api/tools: JSON schemas for 4 tools, compatible with OpenAI/Anthropic tool-calling definitions: recommend, site_survival, model_status and retrain_models.
POST /api/tools/<name>: runs a tool; the request body is its arguments. recommend, site_survival and model_status need no token; retrain_models requires ADMIN_TOKEN.
Live web data: tried and removed

We tried Exa web search for all 56 ZIPs (asking rents, openings, closures, menu prices). 280 searches yielded 38 verifiable openings, 17 closures, 5 rents and 2 menu prices: no ZIP reached the 3 rents needed to replace the survey rent, and news coverage favors popular neighborhoods. Exa is therefore not a data source; the fetch and ingest endpoints, the Evidence section and the live overlay were removed.

5. Self-iteration: periodic retraining
bash
curl -X POST https://<your-domain>/api/admin/retrain -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"download": true}'

This request runs the following in the background: re-download official Chicago data (licenses, population, LODES, CTA, etc.) → rerun all models → promote the new model only if it is no worse than the current one, otherwise roll back automatically → re-export block data.

The check applies to the survival model actually in production (the model step2 selects by independent-restaurant AUC, final_model in the report): its out-of-time Brier score must beat the constant baseline, and under the same metrics version, its independent-restaurant AUC may drop by no more than 0.02 and classifier accuracy by no more than 0.03. A rollback is a normal outcome: job.outcome in /api/status shows rolled_back (or promoted when promoted). Only a failed download or a failed step shows error.

.github/workflows/weekly-refresh.yml sends this request automatically every Monday; you can also trigger it manually from the GitHub Actions page. Versions are recorded in output/model_registry.json, and the 5 most recently promoted versions are kept on disk.

To re-export block data without retraining:

bash
curl -X POST https://<your-domain>/api/admin/export -H "Authorization: Bearer $ADMIN_TOKEN"
6. API overview
Method and path	Token required	Description
GET /	No	Frontend page
GET /data/meta.json, /data/overview.json, /data/blocks/<zip>.json	No	Block data read by the frontend
GET /api/health	No	Liveness check
GET /api/status	No	Whether data is ready, background job, model version, whether the report writer is configured
GET /api/recommend?budget=350000&cuisine=asian	No	Ranks neighborhoods (the 7 with rent research). Optional prior_licenses and entity recompute the survival estimate. Read-only; does not write to disk
GET /api/survival?zip5=60614&cuisine=italian	No	1,000-day license survival estimate for a new independent restaurant in a ZIP, plus the monthly probability that the license is still active. Optional prior_licenses (number of Chicago food licenses previously held), entity (whether incorporated), address (a specific address, to look up its license history). Omitted fields use the mean of recent independent openings in that ZIP
POST /api/report	No	Plain-English report: body {"payload": {...}} built by the web app; returns the sections, untraceable numbers and remaining problems (section 4)
GET /api/tools, POST /api/tools/<name>	Some	Agent tools
POST /api/admin/retrain	Yes	Re-download data and retrain
POST /api/admin/export	Yes	Re-export block data only
GET /api/docs	No	Auto-generated API docs

Endpoints that require a token need the header Authorization: Bearer <ADMIN_TOKEN>. If ADMIN_TOKEN is not set on the server, these endpoints are all disabled.

Operations that write to output/ (first-start data preparation, retraining, export) share a single lock, so only one runs at a time. When the lock is held, they return HTTP 409; wait until job.state in /api/status returns to idle, then retry.

7. Environment variables
Variable	Default	Description
ADMIN_TOKEN	Empty (admin endpoints disabled)	Password for admin endpoints
DEEPSEEK_API_KEY	Empty	Plain-English report writer (section 4); without it, /api/report returns 503
DATA_DIR	./data	Location of raw data; point to the persistent disk when deployed
OUTPUT_DIR	./output	Location of models and exported data; point to the persistent disk when deployed
AUTO_BOOTSTRAP	1	Whether to download and train automatically when no data exists; set to 0 to disable
AS_OF	Date of the downloaded data	The "today" used for estimates; usually leave unset
PORT	8000	Listening port inside Docker (set automatically by Render)
VITE_DATA_BASE, VITE_API_BASE	/data, /api	Only needed when the frontend and backend are deployed separately (set when building the frontend)
8. FAQ
The page stays on "Preparing data": the first start is still downloading and training. Check /api/status: if job.state is error, job.error has the reason. The most common cause is insufficient memory; at least 2 GB is required.
The plain-English report says "report writer not configured": set DEEPSEEK_API_KEY on the server and restart the service.
The plain-English report lists numbers that "could not be traced": DeepSeek used a number that is not in the model results (for example it subtracted two amounts). Do not rely on those numbers; the model results below the report are authoritative.
Retrain or export returns 409: another retrain or export is in progress; retry later.
The page looks broken or goes black after an update: hard-refresh (Cmd+Shift+R on Mac) to load the latest frontend.
The basemap is black: the browser cannot reach basemaps.cartocdn.com. The hexagon data layer is unaffected.
9. Data not yet integrated
Liquor restriction areas: the Chicago Data Portal's dry precincts (Liquor Moratorium Districts – Dry Precincts, y49e-jumb) are integrated. When a liquor license is needed, blocks whose centroid falls in a dry precinct are excluded. This is historical data from 2011 and precinct boundaries have changed since, so verify with BACP before signing a lease. Tavern-restricted street segments do not apply to restaurants per the official guidance, so they are not used.
Hotel rooms, student share: no data; removed from the customer profile.
Live web data: tried and removed (section 4).
Rent: ZIP level only. 7 neighborhoods have team-researched rents; other ZIPs use the median of those 7, and this is flagged under risks.
Average ticket in the frontend: uses sourced benchmark values from the parameter table (full service $24 / $32 / $50 from public chain 10-Ks; no public per-person spend was found for quick service and fast casual, so these are marked "no public source").
Sources for financial parameters

All parameters of the in-browser financial model (41 for full service with a liquor license, slightly fewer for other formats) come from web/src/model/benchmarks.json. Each records its source (publisher, title, link, date, and the raw figure read from the page) and how its triangular distribution [low, most likely, high] was derived. The Assumptions table on the site shows each item's status:

Sourced (14 items): e.g. Chicago minimum wage, BLS OEWS May 2025 wage percentiles for the Chicago metro area (pulled via API), IRS and Illinois unemployment insurance employer tax rates, Chicago BACP license and liquor license fees, per-occupant area from the Chicago Building Code, card processing fees, and delivery platform commissions.
Partially sourced (20 items): a cited figure plus a documented derivation, e.g. revenue, build-out and equipment costs (Item 7 of franchise disclosure documents), ramp-up period, delivery share, NNN.
No public source (7 items): first-month revenue ratio, table turns, occupancy rate, maintenance cost, refurbishment ratio for second-generation equipment, traffic volatility, and the bounds on demand adjustment. Original values are kept and flagged in the table.

Compared with the earlier placeholder values, the sourced figures make opening costs noticeably higher and ramp-up longer, so payback takes longer. For example, for 60614, Italian full service, with a budget cap of $900K, P50 payback goes from 27 months to over 72 months. The biggest drivers are the ramp-up period (6 / 18 / 36 months, taken from the threshold at which chain stores enter same-store sales, which is only a proxy) and the cost of refurbishing a second-generation space ($90 / $175 / $300 per sq ft).

A few constants in the model structure are not in the parameter table and have no public source either: revenue share by daypart (DAYPART_SHARE), daypart durations, the ±10% ticket adjustment by income quantile, staffing ratios based on daily traffic, and the square-root scaling of equipment cost with floor area.

Data sources
Overture Maps places (CDLA-Permissive-2.0)
Chicago Data Portal: Business Licenses r5kz-chrr, Population Counts 85cm-7uqa, CTA 'L' ridership 5neh-572f and stations 8pix-ypme, Food Inspections 4ijn-s7e5, ZIP boundaries unjd-c2ca, dry precincts y49e-jumb
US Census LEHD LODES8 (WAC and RAC)

See docs/data_sources_chicago.md for details.
