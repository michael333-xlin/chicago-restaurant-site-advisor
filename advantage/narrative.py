"""Plain-English report writer.

Turns the model outputs of one analysis (built by the web app, web/src/model/narrativePayload.ts) into a complete
report a first-time restaurant owner can read, using DeepSeek (https://api-docs.deepseek.com/api/create-chat-completion/).

How quality is controlled
  * The system prompt explains every payload field, gives a restaurant-economics primer, the section-by-section
    brief and a self-check list. It contains no numbers, so every number in the report must come from the payload.
  * reference_facts: quotes from official / cited pages (City of Chicago BACP, IRS, IDES, FTC rule, platforms...),
    taken from web/src/model/benchmarks.json, are added to the payload so the checklist sections can be specific.
  * After the first draft, validate() checks structure (every section, one card per site, risk levels) and
    check_numbers() checks that each number can be traced to the payload at its own rounding. If anything fails,
    DeepSeek gets the problem list and revises once. Whatever still fails is returned and shown to the user.

Needs env var DEEPSEEK_API_KEY.

    from narrative import write_report
    write_report(payload)   # -> {"report": {...}, "unverified_numbers": [...], "problems": [...], "revised": bool, ...}
"""
import json
import os
import re
import time
from pathlib import Path

import requests

URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"          # non-thinking mode (thinking disabled below): faster and cheaper for writing
TIMEOUT_S = 150
MAX_TOKENS = 8000
BENCHMARKS = Path(__file__).resolve().parent.parent / "web" / "src" / "model" / "benchmarks.json"
# benchmark entries whose cited quotes help the owner act (licensing, payroll, lease, cash, platforms)
FACT_KEYS = ["licenses", "liquor_license", "payroll_tax", "deposit_months", "reserve_months", "nnn", "rent_var",
             "build_second", "build_vacant", "key_money", "ramp_months", "delivery_fee", "card_fees", "food_cost",
             "insurance", "preopening"]

STRING_KEYS = ["headline", "bottom_line", "your_request", "fit_for_you", "comparison"]
LIST_KEYS = {"what_would_change_the_answer": 2, "next_steps": 4, "questions_to_ask": 4, "chicago_checklist": 4,
             "how_to_read_the_numbers": 4, "data_and_limits": 3}
SITE_KEYS = ["name", "verdict", "best_for", "why_here", "money", "watch_out"]
RISK_KEYS = ["risk", "level", "why_it_matters", "what_to_do"]
CHART_KEYS = ["startup_cost", "payback", "monthly_money"]

SYSTEM = """You are a senior restaurant site-selection advisor in Chicago. You are writing a decision report for a first-time independent restaurant owner who has no background in statistics, finance or data science. The owner will read your report before deciding whether to sign a lease. Write the report a careful, honest human advisor would write: clear, specific, warm, and never more certain than the evidence.

# What you receive
One JSON object with the owner's request and the outputs of OpeningTable's models and simulations for one Chicago ZIP code. Field guide:
- owner_request: the concept, service format, budget range, floor area, storefront preference, liquor license need, meal periods, risk appetite, the rule used to rank sites, and optional facts about the owner (earlier Chicago food licenses, company or individual, an address in mind; null means not given).
- analysis: how many city blocks were checked and simulated, how many plans fit the budget, top_over_budget (true means no plan fits the budget and the sites shown are the closest ones), and case_definitions (how good / typical / cautious cases are defined).
- rent: the base rent per square foot per year used for this ZIP and where it comes from. kind "fallback" means no survey covers this ZIP, so the median of seven surveyed Chicago neighborhoods is used.
- survival: meaning explains the estimate in plain words; estimate is the share for this owner and ZIP; estimate_with_zip_averages_only is the same without the owner's own facts; model_check states how strong the model is.
- sites: up to three ranked sites (rank 1 is the best under the owner's ranking rule). For each: name (a street-corner label), storefront type (a vacant shell needs a full build-out; a second-generation restaurant space was a restaurant before and is cheaper to fit out), within_budget, flags, seats, average_check_usd, guests_per_day and guests_limited_by ("seats" means the room is the limit, "demand" means customers are the limit), startup_cost_usd with good / typical / cautious cases and a breakdown, payback_months with good / typical / cautious cases (null = not within the simulated months), chance_of_no_payback_within_5_years, chance_of_paying_back_before_the_license_ends, annual_profit_typical_usd, monthly_at_steady_state_usd (revenue, the main cost groups and net cash flow), competition (a 0 to 100 score where higher means more pressure, with details comparing restaurants open with the number similar areas support), customers (traits of people nearby and a 0 to 100 fit score for this concept), payback_if_one_driver_moves_10_percent (how payback months change if the average check, guest traffic, rent or food cost is 10 percent lower or higher), and risks (already written, with a level).
- cheapest_plan_if_nothing_fits: only when no site could be shown.
- benchmarks: every industry benchmark the money model uses (items: label, low / most_likely / high, unit, status, source). status "unsourced" means no public source was found.
- reference_facts: quotes from official or cited pages (City of Chicago, IRS, Illinois IDES, the FTC franchise rule, delivery and card platforms, contractors). Use them for the Chicago checklist and practical advice, and name the source in plain words (for example "the City of Chicago licensing office").
- data_snapshot_date, data_sources and limits: where the data comes from and what it cannot tell.

# Restaurant economics primer (use this to explain, never to add numbers)
- Monthly net cash flow is what is left from sales after food and drink, labor, rent and other costs. Food plus labor (prime cost) and rent are the costs that decide whether a restaurant survives.
- Payback is how long it takes for the monthly cash left over to add up to the money spent to open. New restaurants usually start below their normal sales and take months to ramp up, so the first year is the riskiest.
- The startup cost includes build-out, equipment, deposits, licenses, pre-opening costs and a cash reserve. Running out of cash before sales settle is a common way new restaurants fail, which is why the reserve matters.
- A second-generation restaurant space can cut build-out cost and time, but the owner inherits old equipment and should find out why the previous restaurant closed. A vacant shell costs more and takes longer but can be built exactly as needed.
- Competition: fewer restaurants of this type than similar areas support (an unmet-demand gap) is an opportunity signal, not proof that customers will come. Many open restaurants of the same type mean more pressure.
- Most Chicago restaurant leases are NNN (the tenant also pays a share of property taxes, insurance and common-area costs on top of base rent). The rent in this report is an estimate for the ZIP, not a quote for a specific space.
- A license that is still active is not the same as a restaurant that is still open; the survival estimate measures license renewal.
- Tailor the advice to the owner's risk appetite: for a conservative owner, lead with the cautious case and the cash reserve; for a balanced owner, lead with the typical case; for an aggressive owner, lead with profit while still naming the downside.

# Number discipline (strict)
- Use only numbers that appear in the JSON. Never invent or estimate a number, and never use a number from your own knowledge.
- You may round: money to the nearest $1,000 (for example $547k), months to whole months, percentages to whole percent. Do not do arithmetic: no sums, differences, ratios, conversions or averages. To compare two amounts (for example a startup cost and the budget), state both amounts.
- Shares in the JSON are fractions (0.91 means 91 percent).
- If a payback month is null, say the plan does not pay back within the simulated months.
- If something the owner would want is not in the JSON (for example a real rent quote for a specific space), say it is not available and how to get it.

# Writing rules
- Plain English, short sentences, active voice, address the owner as "you".
- Explain a technical idea the first time it appears. Use "typical case", "good case" and "cautious case", "1,000 possible futures we simulated", "chance of paying back before the license ends". Do not use AUC, Brier, Monte Carlo, P10, P50, P90, Poisson, percentile or standard deviation without explaining them in plain words.
- Be honest about uncertainty: revenue and costs come from industry benchmarks, not local sales records; some benchmarks have no public source (listed in benchmarks); the survival estimate is a weak signal; name the specific limits that matter for this ZIP.
- If top_over_budget is true, say clearly in the headline and bottom line that no plan fits the budget, present the sites as the closest options, and compare their startup costs with the budget by stating both amounts.
- Be specific to this ZIP and these sites. Avoid generic filler such as "do your research" without saying what to check and how.
- This is a planning aid, not legal, tax or financial advice; say once that the owner should confirm lease, license and tax questions with a broker, lawyer or accountant.

# Output
Return one JSON object (no markdown, no text outside the JSON) with exactly these keys:
"headline": one sentence with the main answer.
"bottom_line": 3 to 5 sentences: is this ZIP a good fit for this concept, which site leads and why, the biggest caveat, and the single most important next step.
"your_request": 1 to 2 sentences restating what the owner asked for, including budget, concept, format and anything they told us about themselves.
"fit_for_you": 2 to 4 sentences on how these results fit the owner's budget, risk appetite and situation (use their own facts if given).
"sites": a list with exactly one object per site in the JSON, in the same order. Each object has:
  "name": the site's name exactly as in the JSON;
  "verdict": one sentence;
  "best_for": a short phrase saying what kind of owner or plan this site suits;
  "why_here": 2 to 3 sentences on customers nearby and competition;
  "money": 3 to 4 sentences on startup cost (and the budget), monthly sales and net cash flow, typical payback, the good and cautious cases, and the chance of paying back before the license ends;
  "watch_out": 1 to 3 sentences on this site's main risks and how to check them.
"comparison": 3 to 5 sentences comparing the sites: the trade-offs between payback, cost, competition and customers, and which site suits which kind of owner.
"chart_notes": an object with a 1 to 2 sentence takeaway for each of the three charts shown next to your text. Say what the reader should notice for these sites, not how the chart is built, and describe the marks correctly (dots and lines, or stacked bars; never call a dot a bar):
  "startup_cost": the chart has one row per site, a dot at the typical startup cost, a horizontal line from the good case to the cautious case, and a shaded band for the owner's budget range;
  "payback": the chart has one row per site, a dot at the typical payback month, a line from the good case to the cautious case, and a vertical line at 5 years;
  "monthly_money": the chart has one horizontal stacked bar per site splitting steady-state monthly sales into food and drink, labor, rent including NNN, other costs and net cash flow, with the net cash flow written at the end of each bar.
"what_would_change_the_answer": 2 to 4 sentences or items, based on payback_if_one_driver_moves_10_percent and the flags: which assumption moves payback the most and what that means for the owner.
"risks": a list of 3 to 6 objects, most serious first, each with "risk" (short title), "level" ("high", "medium" or "low", following the levels in the JSON), "why_it_matters" (one sentence) and "what_to_do" (one concrete action).
"next_steps": a list of 4 to 7 concrete actions in the order the owner should do them.
"questions_to_ask": a list of 4 to 7 specific questions to ask the landlord, broker or city before signing.
"chicago_checklist": a list of 4 to 7 Chicago licensing, permit, payroll and lease items drawn from reference_facts (include the liquor items only if the owner needs a liquor license); say which office or source each comes from.
"how_to_read_the_numbers": a list of 4 to 6 short plain-English explanations of the terms used in this report.
"data_and_limits": a list of 3 to 5 short statements about where the data comes from and what it cannot tell.

# Before you answer, check
1. Every number you wrote appears in the JSON (rounding allowed, no arithmetic).
2. The sites list has exactly one entry per site, in order, with names copied from the JSON.
3. Every key above is present and each list has the required length.
4. No jargon is left unexplained.
5. The tone is honest: no promises, and the main uncertainties are named.
"""


class NarrativeError(RuntimeError):
    pass


# ------------------------------------------------------------------ reference facts (cited quotes)
def reference_facts():
    """Cited quotes from the benchmark research (official pages first), for the checklist and practical advice."""
    try:
        bench = json.loads(BENCHMARKS.read_text())
    except (OSError, ValueError):
        return []
    out = []
    for key in FACT_KEYS:
        entry = bench.get(key) or {}
        for src in (entry.get("sources") or [])[:3]:
            fig = (src.get("figure") or "").strip()
            if not fig or "search summary only" in (src.get("publisher") or "").lower():
                continue
            out.append({"topic": key.replace("_", " "), "fact": fig[:420], "source": src.get("publisher"),
                        "url": src.get("url"), "date": src.get("date")})
    return out


# ------------------------------------------------------------------ DeepSeek call
def _call(messages, api_key, retries=2):
    body = {"model": MODEL, "thinking": {"type": "disabled"}, "temperature": 0.3, "max_tokens": MAX_TOKENS,
            "response_format": {"type": "json_object"}, "messages": messages}
    for attempt in range(retries + 1):
        r = requests.post(URL, json=body, timeout=TIMEOUT_S,
                          headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        if r.status_code in (429, 500, 503) and attempt < retries:
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code != 200:
            raise NarrativeError(f"DeepSeek HTTP {r.status_code}: {r.text[:300]}")
        return r.json()
    raise NarrativeError("DeepSeek: retries exhausted")


def _parse(resp):
    choice = resp["choices"][0]
    try:
        return json.loads(choice["message"]["content"]), choice.get("finish_reason")
    except (TypeError, ValueError) as e:
        raise NarrativeError(f"DeepSeek returned no valid JSON (finish_reason={choice.get('finish_reason')})") from e


# ------------------------------------------------------------------ number check
_NUM = re.compile(r"(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|K|M|million|%)?(?![\w])")


def _numbers(text):
    """(value, rounding step, token) for every number in text; '$547k' -> 547000, '73%' -> 73."""
    out = []
    for m in _NUM.finditer(text):
        whole, frac, unit = m.group(2).replace(",", ""), m.group(3) or "", m.group(4) or ""
        v = float(whole + frac)
        step = 10 ** -(len(frac) - 1) if frac else 1.0
        if not frac and not unit and v >= 1000:      # "about 42,000" is rounded to the thousand: compare at that precision
            step = 10.0 ** min(3, len(whole) - len(whole.rstrip("0")))
        if unit in ("k", "K"):
            v, step = v * 1e3, step * 1e3
        elif unit in ("M", "million"):
            v, step = v * 1e6, step * 1e6
        out.append((v, step, m.group(0).strip()))
    return out


def _payload_values(obj, acc):
    if isinstance(obj, bool) or obj is None:
        return acc
    if isinstance(obj, (int, float)):
        acc.append(float(obj))
        if 0 <= obj <= 1:
            acc.append(float(obj) * 100)      # shares written as percentages
    elif isinstance(obj, str):
        acc.extend(v for v, _, _ in _numbers(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            _payload_values(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _payload_values(v, acc)
    return acc


def _strings(obj, path=""):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _strings(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _strings(v, f"{path}[{i}]")


def check_numbers(report, payload):
    """Numbers in the report that match no payload value within their own rounding (small counts up to 12 pass)."""
    vals = _payload_values(payload, [])
    bad = []
    for where, text in _strings(report):
        for v, step, token in _numbers(text):
            if v <= 12 and v == int(v):
                continue
            tol = max(step / 2 + 1e-9, 0.006 * abs(v))
            if not any(abs(v - p) <= tol for p in vals):
                bad.append({"where": where, "number": token})
    return bad


# ------------------------------------------------------------------ structure
def normalize(report):
    """Coerce the model's JSON into the shape the web app renders (strings and lists of strings / objects)."""
    r = report if isinstance(report, dict) else {}
    out = {k: str(r.get(k) or "") for k in STRING_KEYS}
    out["sites"] = [{k: str(s.get(k) or "") for k in SITE_KEYS} for s in r.get("sites") or [] if isinstance(s, dict)]
    notes = r.get("chart_notes") if isinstance(r.get("chart_notes"), dict) else {}
    out["chart_notes"] = {k: str(notes.get(k) or "") for k in CHART_KEYS}
    risks = []
    for x in r.get("risks") or []:
        if isinstance(x, dict):
            lvl = str(x.get("level") or "").lower()
            risks.append({**{k: str(x.get(k) or "") for k in RISK_KEYS}, "level": lvl if lvl in ("high", "medium", "low") else "medium"})
        elif x:
            risks.append({"risk": str(x), "level": "medium", "why_it_matters": "", "what_to_do": ""})
    out["risks"] = risks
    for k in LIST_KEYS:
        v = r.get(k)
        out[k] = [str(x) for x in v if x] if isinstance(v, list) else ([str(v)] if v else [])
    return out


def validate(report, payload):
    """Structural problems in a normalized report, as instructions DeepSeek can act on."""
    problems = []
    for k in STRING_KEYS:
        if len(report[k].strip()) < 20:
            problems.append(f'"{k}" is missing or too short.')
    sites = payload.get("sites") or []
    if len(report["sites"]) != len(sites):
        problems.append(f'"sites" must have exactly {len(sites)} objects, one per site in the JSON, in order.')
    for i, (got, want) in enumerate(zip(report["sites"], sites)):
        if got["name"].strip().lower() != str(want.get("name", "")).strip().lower():
            problems.append(f'sites[{i}].name must be "{want.get("name")}" exactly as in the JSON.')
        for k in SITE_KEYS[1:]:
            if len(got[k].strip()) < 10:
                problems.append(f"sites[{i}].{k} is missing or too short.")
    for k in CHART_KEYS:
        if sites and len(report["chart_notes"][k].strip()) < 20:
            problems.append(f'chart_notes.{k} is missing or too short.')
    if not 3 <= len(report["risks"]) <= 6:
        problems.append('"risks" must have 3 to 6 objects.')
    for i, x in enumerate(report["risks"]):
        if not x["why_it_matters"] or not x["what_to_do"]:
            problems.append(f"risks[{i}] needs why_it_matters and what_to_do.")
    for k, n in LIST_KEYS.items():
        if len(report[k]) < n:
            problems.append(f'"{k}" must have at least {n} items.')
    return problems


# ------------------------------------------------------------------ entry point
def write_report(payload):
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise NarrativeError("DEEPSEEK_API_KEY is not set on the server")
    full = {**payload, "reference_facts": reference_facts()}
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": "Owner request and model outputs (JSON):\n" + json.dumps(full)}]
    resp = _call(messages, key)
    raw, finish = _parse(resp)
    report = normalize(raw)
    problems, bad = validate(report, full), check_numbers(report, full)
    usage = [resp.get("usage")]
    revised = False
    if problems or bad:
        fix = problems + [f'In {b["where"]}, the number "{b["number"]}" does not appear in the JSON (or is computed). '
                          f'Replace it with a number from the JSON or rewrite the sentence without it.' for b in bad]
        messages += [{"role": "assistant", "content": json.dumps(raw)},
                     {"role": "user", "content": "Revise your JSON report. Fix every problem below, keep everything else, "
                                                 "and return the complete corrected JSON object:\n- " + "\n- ".join(fix)}]
        resp2 = _call(messages, key)
        raw2, finish = _parse(resp2)
        report = normalize(raw2)
        problems, bad = validate(report, full), check_numbers(report, full)
        usage.append(resp2.get("usage"))
        revised = True
    return {"report": report, "unverified_numbers": bad, "problems": problems, "revised": revised,
            "model": resp.get("model", MODEL), "usage": usage, "finish_reason": finish,
            "reference_facts": [{k: f[k] for k in ("topic", "source", "url")} for f in full["reference_facts"]]}
