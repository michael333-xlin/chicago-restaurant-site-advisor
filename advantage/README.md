# OpeningTable: Chicago Restaurant Site Model

> For deployment, running the app and fetching new data, see [README.md](../README.md) in the repository root. This document covers only the model methodology and validation results.

The question: **for an independent restaurant on a limited budget, which Chicago neighborhood gives it the best advantage?**

Given a budget and restaurant type, the model first drops neighborhoods the budget can't afford, then ranks the rest on three testable measures:

| Ranking input | Meaning | Source |
|---|---|---|
| Supply gap | **Cuisine supply shortfall vs. peer areas**: compared with ZIPs that have similar population, employment and income structure and the same total number of restaurants, how many fewer restaurants of this type are here. It is not a demand forecast | Overture snapshot + ZIP features, leave-one-ZIP-out Poisson model (step3); historical backtest in step4 |
| Base-case payback months | Payback months from teammate's `finance.calc` | finance/ |
| Monthly profit at −30% traffic | Same model, with traffic multiplied by 0.7 | finance/ |

`score` = the average of the three measures' percentile ranks among candidate neighborhoods. When the gap model is unreliable for a cuisine, the gap measure is set to a neutral 50.

The **1,000-day license survival estimate** is shown separately and **does not affect the score**. Its signal is weak: out-of-time AUC for independent restaurants is about 0.61, and the label itself is noisy (see step2b). Users can add their own operating experience, entity type and specific address, and the model recomputes; any field left blank uses the mean of recent independent openings in that ZIP.

## Running

From the repository root (Python 3; requires pandas, numpy, scikit-learn, statsmodels, scipy, pyarrow, matplotlib, requests):

```bash
bash advantage/step0_download.sh                         # Download public data to data/raw/ and write MANIFEST.json (pinned snapshot)
cp ~/Downloads/chicago_restaurant_categories.csv data/   # Overture snapshot, 11,875 rows; or set the RESTAURANT_CSV environment variable
python3 advantage/snapshot.py check                      # Confirm data/raw/ matches the snapshot manifest
python3 advantage/step1_cuisine_classifier.py            # Name → cuisine, name-grouped cross-validation + out-of-fold predictions
python3 advantage/step2_survival_model.py                # Leakage-free survival model, rolling validation, calibration, ablation
python3 advantage/step2b_label_audit.py                  # Audit the label definition (reissues, relocations, gaps, food inspections)
python3 advantage/step4_backtest_gap.py                  # Supply gap backtest and stability (run before step3)
python3 advantage/step3_advantage_index.py               # ZIP × cuisine gap scores, survival estimates, finance summary
python3 advantage/export_web.py                          # Export block data for the frontend to output/web_data/
python3 advantage/recommend.py --budget 250000 --cuisine fast_food
```

You can also run steps 1–4 plus export, with version comparison, in one command: `python3 advantage/agent_api.py retrain --no-download` (about 1 minute). Every report carries a `snapshot_id`, and **only reports with the same id are comparable**. Round 2 numbers come from snapshot `4cd24f7051fa` (downloaded 2026-11-14; it differs from `22397a5a242b` only by the added dry-precinct file, so the training data is identical). Round 1 numbers come from snapshot `1f4965d4c768`; rerunning round 1 code on data re-downloaded on 2026-11-14 reproduces every reproducible metric exactly.

## Round 2: data audit and model improvements (2026-11-14, snapshot 4cd24f7051fa)

### 0. Is any data random or fabricated?

- In the Python pipeline, random numbers are used only for fixed-seed sampling: 40 points per ZIP in step3, ZIP grouping in step4, and audit samples. No data is generated.
- Traceability checks: rescoring with `survival_model.pkl` matches the CAI table with a maximum difference of 4.9e-5 (rounding); the web blocks' `survivalModel1000d` equals the weighted CAI value; block restaurant counts match the raw Overture file cell by cell.
- Permutation test: with shuffled labels, the same rolling validation gives AUC 0.49–0.50, versus 0.56–0.61 with real labels, so the signal is real.
- Parts that do not come from trained models: in-browser payback and P&L come from the financial parameter table plus Monte Carlo, with parameter sources shown in the site's Assumptions table. Rent is ZIP-level only, and 86% of blocks use the median of the 7 surveyed neighborhoods.

### 1. Survival model: 3 new point-in-time features

All use only information from before the opening date t (`features.LicenseHistory`):

| Feature | Definition |
|---|---|
| `log_acct_prior_c` | Number of **other** licenses under the same account number that started before t, capped at 10 (so the linear model doesn't extrapolate on large accounts) |
| `entity` | 1 if the legal name on the opening license record is a company (LLC, Inc, Corp, etc.), 0 if an individual |
| `log_addr5_ended` | Number of food licenses at the same address (floor and unit removed) that expired in the 5 years before t and were still not renewed 60 days after expiry |

The address feature originally counted only "restaurant-type" licenses, but most old records leave business_activity blank, so the feature mean rose from 0.04 in 2013 to 0.52 in 2022 and hurt calibration. After switching to a fixed 5-year window counting all food licenses, it is stable at 0.65–0.76 across years.

**Same rolling validation (test set 3,907 restaurants, 2,764 independent)**

| Feature set (logistic regression) | Independent AUC | All AUC | Brier (all) | Calibration slope |
|---|---|---|---|---|
| Round 1 selected model (no operator, no address) | 0.570 | 0.563 | 0.199 | 0.48 |
| + address history | 0.583 | 0.576 | — | — |
| + operator | 0.596 | 0.600 | — | — |
| **+ operator and address (round 2 selection, `no_chain_no_local`)** | **0.607** | **0.611** | **0.1925** | **0.64** |
| All features (incl. chain and 500m competition) | 0.606 | 0.628 | 0.191 | 0.69 |

- The constant baseline's Brier is 0.1996. The selection rule is unchanged: highest independent AUC, choosing fewer features when within 0.005.
- Independent AUC by test year, 2018–2022: 0.538, 0.600, 0.625, 0.627, 0.699; the round 1 model scored 0.506, 0.551, 0.551, 0.632, 0.645. The round 1 model was essentially random in 2018.
- Bootstrap stratified by test year, 2,000 draws: independent AUC improves by +0.035, 95% interval [0.018, 0.052]; all-sample AUC improves by +0.047, interval [0.032, 0.062].
- Checked against the operating-status alternative label (step2b): independent AUC rises from 0.537 to 0.574, so the gain is not just about "was the license renewed."
- New recalibration parameters: a = 0.54, b = 0.64.
- Also tried: tuned GBM (worse), logistic regression + GBM ensemble (+0.002, not worth the complexity), opening month and distance to an L station (no gain).

**Scoring a hypothetical new restaurant** (step3, `/api/survival`): operator and address features default to the mean of 2020–2022 independent openings in that ZIP (the citywide mean when there are fewer than 10, which applies to 6 of 56 ZIPs). Users can enter the number of licenses previously held, entity type and a specific address; filled-in fields replace the defaults, and the result marks whether each input came from the user or the ZIP mean. Addresses are matched against the same street number in Chicago license data. A miss may just mean a different spelling, so the endpoint returns the number of licenses matched.

### 2. License survival curve (new)

- A Kaplan–Meier curve of license duration built from all openings (censored at the data date). A site's curve is scaled by proportional hazards: `S_site(m) = S_city(m) ^ (log p_site / log S_city(1000 days))`.
- The site combines it with each Monte Carlo run's payback month to give the "**probability the license is still active at payback**."
- Out-of-time test (for each test year, the curve is built from earlier data and recalibration parameters are fit on other years):

| Month | Predicted license active | Actual | Mean quintile error | AUC |
|---|---|---|---|---|
| 12 | 99.5% | 99.4% | 0.006 | 0.55 |
| 24 | 96.5% | 96.5% | 0.019 | 0.47 |
| 36 | 73.2% | 71.7% | 0.053 | 0.62 |

- Chicago licenses run in two-year terms, and a closure only shows up when the term ends, so the curve has steps at months 24–25 and 48–50 and almost no discrimination within the first 24 months. The curve means "license still active," **not "still operating."**

### 3. Supply gap model: regularization alpha 1.0 → 0.1

| | alpha = 1.0 (round 1) | alpha = 0.1 (round 2) |
|---|---|---|
| Leave-one-ZIP-out correlation on annual license snapshots (9-year mean) | 0.732 | 0.764 |
| Backtest coefficient (controlling for cuisine, year, chain) | 0.027 (p = 0.059) | 0.035 (p = 0.042) |
| Years where Q5 beats Q4 | 7/9 | 6/9 |

- alpha was picked from 5 variants (0.1, 0.3, 1, 3, and one with two extra features), so the backtest p-value should be discounted. It was chosen mainly because the model predicts per-ZIP restaurant counts better.
- Years where Q5 beats Q4 dropped to 6/9, below 70%, so under step4's predefined rule the gap score is **capped** at the Q4/Q5 boundary (gap_z = 0.525).
- Per-cuisine leave-one-out correlation (Overture) improved: steakhouses 0.31 → 0.52, fried chicken 0.31 → 0.50, Caribbean/African 0.05 → 0.21. Steakhouses crossed the 0.4 threshold, so their gap score now counts in the ranking.

| Gap quintile (3,760 openings, 2014–2022) | 1,000-day license survival |
|---|---|
| Q1 most supply | 67.4% |
| Q2 | 69.0% |
| Q3 | 70.7% |
| Q4 | 72.1% |
| Q5 least supply | 73.7% |

### 4. Cuisine classifier: no room for improvement

With C from 4–32 and character n-grams changed to (1,6) or (2,6), name-grouped cross-validation accuracy stays within 64.8% ± 0.15%; settings only trade precision for coverage. Names alone have hit the ceiling, so nothing was changed.

### 5. Rollback check

`agent_api.py` used to decide promotion based on the all-feature GBM's AUC and Brier, while the deployed model is the logistic regression selected by independent AUC. The step2 report now writes `final_model` (the deployed model's out-of-time metrics), the rollback check uses it, and `METRIC_VERSION` is bumped to 3.

## Round 1: post-review fixes and results (snapshot 1f4965d4c768)

> These are round 1 results. The final selected model, step4 quintiles and gap model numbers were updated in round 2; the section above takes precedence.

### 1. Survival model: removing time leakage

| Issue | Before | After |
|---|---|---|
| Citywide and ZIP historical survival rates | The citywide prior used the full-sample mean | Uses only labels that had **reached 1,000 days** before t; missing until the earliest labels mature |
| Train/test boundary | Train 2013–2018, test 2019–2022; labels for 2018 openings weren't known until 2021 | Rolling validation: test years Y = 2018–2022, training only on openings whose labels **had matured before Jan 1 of Y** |
| Missing historical population | Backfilled from later years (83.5% of samples used "future" population) | No backfill; missing before 2018 (76% of samples) |
| Names and addresses for competition, chain and cuisine | The **latest** name and address for each license number | Uses every license record: the name and address on the record active at t (`license_spans.parquet`). Relocations and renames no longer leak into the past |
| Chain flag | Computed from the license's latest name | Number of **other** licenses that used the same name before t |
| Cuisine label | Classifier predicted in-sample | Out-of-fold predictions: each name is predicted by a model that never saw it in training |

### 2. Comparing models under the same validation (rolling validation, test set 3,907)

| | Original README (single split) | Original feature table + new validation | **Fixed version** |
|---|---|---|---|
| AUC all: GBM / logistic | 0.608 / 0.606 | 0.583 / 0.583 | **0.585 / 0.596** |
| AUC independent: GBM / logistic | — | 0.562 / 0.564 | **0.562 / 0.570** |
| Per-test-year AUC mean ± SD (logistic) | — | 0.592 | 0.600 ± 0.036 |
| Brier all: constant / GBM / logistic | 0.205 / 0.199 / 0.200 | 0.200 / 0.199 / 0.203 | 0.200 / 0.198 / **0.196** |
| Calibration ECE: GBM / logistic | — | 0.075 / 0.091 | 0.066 / 0.068 |
| Calibration slope: GBM / logistic | — | 0.49 / 0.38 | 0.53 / 0.61 |

Conclusions:
- **The original README's 0.608 came mostly from a lenient validation setup.** Under the same rolling validation, the original feature table drops to 0.583, and the fixed version scores 0.585–0.596. Leakage itself inflated the result only slightly.
- **Logistic regression is no worse than GBM** and is better calibrated, so XGBoost and LightGBM were not tried.
- Per-test-year AUC rises as training data grows: 0.54 (2018 test, only 2,016 training restaurants) → 0.65 (2022 test).
- **A calibration slope around 0.5 means the raw predictions are too extreme.** A logistic recalibration layer was fit on the rolling-validation out-of-time predictions (a = 0.70, b = 0.48). The resulting ECE is 0.014, but that is measured on the data it was fit to, so it is optimistic.
- The constant baseline's pooled AUC is 0.456, below 0.5. This is because survival rates differ across test years (82% in 2018, 70–73% in other years), and pooling years for AUC produces this bias. Each single-year AUC is 0.5.

**Ablation (pooled AUC; independent / all)**

| Feature set | Logistic: independent | Logistic: all | GBM: independent |
|---|---|---|---|
| All features | 0.570 | 0.596 | 0.562 |
| Drop chain flag | 0.568 | 0.560 | 0.558 |
| Drop chain + 500m competition | **0.570** | 0.563 | 0.564 |
| Drop chain + ZIP features and ZIP history | 0.550 | 0.544 | 0.542 |
| Location features only (competition + ZIP) | 0.564 | 0.552 | 0.559 |
| Cuisine and format only | 0.520 | 0.520 | 0.521 |

- The chain flag helps only on the full sample (0.596 → 0.560) and **does nothing for independent restaurants**.
- **500m competition features add nothing.**
- **The signal is in ZIP-level features**: demographic/economic features and ZIP historical survival. Removing them drops independent AUC from 0.568 to 0.550.
- Final model: logistic regression with "cuisine + format + ZIP features + ZIP history" (`no_chain_no_local`). The selection rule is highest independent AUC, choosing fewer features when within 0.005.
- Historical rent features were not added: no rent data could be aligned to opening dates.

### 3. Label definition audit (step2b, 8,595 restaurants)

Current label: license survives ≥ 1,000 days. Checked against license records and food inspections (4ijn-s7e5):

| Case | Labeled "survived" | Labeled "closed" |
|---|---|---|
| Relocation: same account got a C_LOC license within 180 days. In Chicago a relocation **issues a new license number**, so the old license counts as "closed" | — | 0.7% |
| Same name and address got a new license number within 180 days (new entity or owner) | — | 1.8% |
| Any new license at the same address within 180 days (new tenant or rename, indistinguishable) | — | 22.8% |
| License gap: more than 60 days between two records | 0.2% | 0% |
| Inspection result already Out of Business before day 1,000 | **9.3%** | — |
| Inspections still recorded 90+ days after license expiry | — | **27.9%** |

- An alternative label based on operating status: relocations, same-name relicensing and post-expiry inspections are changed to "survived"; Out of Business inspection results within 1,000 days are changed to "closed." The alternative label agrees with the current one only **84.5%** of the time: 770 samples flip from closed to survived and 560 from survived to closed.
- Validated against the alternative label, the same model scores AUC 0.537, below 0.563 on the original label. So part of what the model learns is "was the license renewed," not purely "is the restaurant still open."
- Sample rows are in `output/step2b_label_samples.csv`, up to 15 per case, for manual review.

### 4. Cuisine classifier (step1)

- 5-fold cross-validation grouped by normalized name, so same-name chain locations never appear in both training and test. Cuisine accuracy is **64.8%** (versus 71% with the earlier random split; majority-class baseline 22%). At confidence ≥ 0.5, precision is 78.1% with 72.7% coverage.
- Per-cuisine results are in `step1_classifier_report.json`. Mexican and pizza exceed 0.88 precision at confidence ≥ 0.5. **European 0.24, healthy/light 0.36, seafood 0.50, steakhouse 0.52**: these labels are unreliable on historical data.
- Transfer check (can out-of-fold predictions be applied to closed historical restaurants?): 50.3% of closed openings get a high-confidence cuisine versus 48.6% of survivors. The two are close, so whether cuisine is known is unrelated to the outcome. A sample of predictions for closed restaurants is in `step1_closed_sample.csv` for manual review.

### 5. Supply gap stability (step4, 3,760 openings, 2014–2022)

| Gap quintile | 1,000-day license survival | n |
|---|---|---|
| Q1 most supply (relative to peer areas) | 67.6% | 754 |
| Q2 | 70.1% | 750 |
| Q3 | 70.9% | 756 |
| Q4 | 71.6% | 750 |
| Q5 least supply | 72.7% | 750 |

- After the fixes, the five quintiles are monotonic. In the original, Q5's 72.1% was below Q4's 74.2%; that no longer happens.
- Controlling for cuisine, year and chain, the coefficient is 0.027 (p = 0.059); without controls, p = 0.008.
- Across years: the coefficient is positive in 6 of 9 years, Q5 beats Q4 in 7, and Q5 beats Q1 in 7.
- Across ZIPs: the coefficient is positive in 4 of 5 random ZIP groups, and in both the north and south halves.
- Conclusion: the signal is weak but directionally stable, so it is used as one of three ranking inputs, without a cap (rule: cap only when Q5 beats Q4 in fewer than 70% of years).

### 6. Demo ranking changes

- Before: `0.5 × CAI + 0.5 × P(survive to payback)`. The survival score was counted twice (once in CAI, once in the payback probability), and the payback probability assumed a constant monthly closure risk.
- Now: filter by budget, then rank by supply gap, base-case payback months and monthly profit at −30% traffic. The survival estimate is shown separately, labeled "1,000-day license survival estimate."
- A talking point for the demo: whether an area loses money if traffic drops 30%, and by how much. This is in the `stress_test` field.

## Recommendation engine `recommend.py`

```bash
python3 advantage/recommend.py --budget 350000 --cuisine asian
python3 advantage/recommend.py --budget 250000 --cuisine fast_food --traffic 0.9 --food 1.15   # Custom scenario (the stress test applies a further 0.7× traffic on top)
python3 advantage/recommend.py --budget 250000 --cuisine fast_food --space second_gen           # Take over an existing restaurant space
```

From Python: `from recommend import Engine; Engine().recommend(350_000, "asian")`, with optional `prior_licenses=` and `entity=` to recompute the survival estimate (does not affect ranking). Output goes to `output/recommend_<cuisine>_<budget>.json`, and the map layer to `output/map_<cuisine>.geojson`: neighborhood polygons carry `score`, ZIPs carry `gap_score`.

| Product feature | Implementation | Status |
|---|---|---|
| 1 Smart site selection | Budget filter → three-measure ranking → top 5 with reasons; map GeoJSON | ✅ Payback can only be computed for the 7 neighborhoods in `rent_by_area.json` (plus new areas with live rents) |
| 2 Competition analysis | Count and density of same-type restaurants in the neighborhood, supply gap, 1,000-day license survival for same-type restaurants 2018–2022 | ✅ |
| 3 Customer fit | Population, employment, income relative to the city, share aged 18–39, `fit_ratio` | ✅ Income is 2008–2012 data |
| 4 Return on investment | `finance.calc`; `demand_index` replaced with supply gap, `income_index` replaced with actual income ratio | ✅ With live price data, the average ticket uses actual prices; the site also shows "probability the license is still active at payback" |
| 5 Risk and stress testing | finance's three checks + −30% traffic scenario; `--traffic` and `--food` can be wired to frontend sliders | ✅ |
| 6 AI advisor report | Exa fetch, live ingest, agent tool endpoints | ⚠️ Endpoints done, report generation not done |
| 7 Advisory recommendations | Payback comparison of new build-out vs. taking over a space (`space_comparison`) | ⚠️ Lease checklist and permit checklist not done |

## Live data and self-iteration (`live.py`, `exa_fetch.py`, `agent_api.py`)

| | Live overlay (seconds) | Retraining (about 1 minute, plus about 2 minutes to download) |
|---|---|---|
| Trigger | Agent calls `ingest_records` | `agent_api.py retrain`, can run weekly via cron |
| Effect | Openings/closures change supply counts and gaps; agent/manual rents (≥ 3 for the same area) override finance values and add a candidate area for a new ZIP, while rule-extracted rents are evidence only; prices (≥ 3) replace the estimated average ticket; news is attached to results | Reruns step1 → 2 → 2b → 4 → 3. The deployed model (`final_model`) must beat the constant baseline on Brier; within the same metric version, its independent AUC may drop by no more than 0.02 and classifier accuracy by no more than 0.03. Otherwise it rolls back |
| Records | Every record must have a `source_url` | `model_registry.json` (includes `metric_version`; the baseline resets when metric definitions change); `versions/` keeps the last 5 versions |

Field definitions for the four live record kinds are in `live.SCHEMAS`: `places`, `rents`, `prices`, `signals`. Exa requires the `EXA_API_KEY` environment variable. Regex extracts only rents and news automatically; openings, closures and prices are extracted by an agent reading the page, which then calls `ingest_records`. Commands: `agent_api.py fetch | ingest | recommend --live | retrain | status | tools`. Tests with synthetic data: `python3 advantage/test_live.py` (includes checks for the rent replacement rule and optional operator inputs).

## Time alignment rules

Openings in year Y (or the Jan 1 snapshot of year Y in the backtest) use only ZIP features from **data year Y−2**:

| Feature | Alignment | Remaining issue |
|---|---|---|
| Employment (LODES) | Exactly year Y−2 | None |
| Competition, chain, cuisine, ZIP historical survival | License records active at t, and labels matured before t | None |
| Operator experience, entity type | Other licenses on the same account that started before t; legal name on the opening record | None |
| Address history | Licenses at the same address that expired in the 5 years before t and were not renewed within 60 days | Renewals delayed more than 60 days are miscounted as closures (step2b: license gaps are 0.2%) |
| Population and ethnic composition | Latest value ≤ Y−2, **no backfill** | Missing before 2018. Could be filled with ACS after obtaining a `CENSUS_API_KEY` |
| Neighborhood income (2008–2012) | Static, predates all openings | ZIP → neighborhood weights use the license distribution across all years (minor effect) |

## Output files (`output/`)

- `license_spans.parquet`: validity period, address, name and out-of-fold cuisine probabilities for every license record
- `survival_training_table.parquet`, `survival_model.pkl` (includes calibration parameters and the license survival curve)
- `survival_points.parquet`, `survival_defaults.json`: step3 sample points and default inputs, used by `/api/survival` to recompute from user input
- `competitive_advantage_by_zip_cuisine.csv`: for each ZIP × cuisine, `gap_score`, `gap_z`, actual count, expected count, `p_license_1000d`, plus CAI kept for reference
- `finance_by_area.csv`: 7 neighborhoods × 4 cuisine types, including payback months, profit at −30% traffic, and survival estimate
- `step1_classifier_report.json`, `step1_closed_sample.csv`
- `step2_survival_report.json`: includes per-test-year, pooled, ablation, original-table comparison and calibration results
- `step2b_label_audit.json`, `step2b_label_samples.csv`
- `step4_backtest_report.json`: includes per-year, per-ZIP-group and north/south results
- `model_registry.json`, `versions/`

## Known limitations

1. The survival model's signal is weak: independent out-of-time AUC is about 0.61, and the label agrees with actual operating status only about 85% of the time. The license survival curve reflects two-year license renewals, not how long a restaurant operates.
2. The supply gap comes from comparison with peer areas; it is not demand. Loop, River North and Streeterville have extremely high employment-to-population ratios, so estimates there are extrapolations.
3. Only 7 neighborhoods have rent data. Other areas need live rent records before payback can be computed.
4. No ZIP population data before 2018 (no Census key).
5. Dry precincts are 2011 historical data, and precinct boundaries have changed since.
