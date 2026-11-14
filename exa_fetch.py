"""Fetch fresh web data with Exa (https://docs.exa.ai/reference/search) and turn it into live records.

Flow:  exa_search() -> raw JSON saved under data/live/exa_raw/  -> baseline_extract() -> LiveStore.ingest()

The regex baseline only extracts what is reliably pattern-shaped: asking rents ($/SF) and news signals.
Openings/closures and menu prices need reading comprehension: the agent reads `results[i].text`,
builds records in the live.SCHEMAS format and calls ingest_records (see agent_api.py).

Requires env var EXA_API_KEY.
"""
import hashlib
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone

import requests

from live import LIVE_DIR

EXA_URL = "https://api.exa.ai/search"
RAW_DIR = LIVE_DIR / "exa_raw"

LABEL = {"fast_food": "fast food", "italian": "Italian", "steakhouse": "steakhouse", "asian": "Asian"}
TOPICS = {
    "rents": "{area} Chicago restaurant space for lease asking rent per square foot",
    "openings": "new {label} restaurant opening {area} Chicago",
    "closures": "restaurant closing closed {area} Chicago",
    "prices": "{label} restaurant menu prices {area} Chicago",
    "development": "{area} Chicago new development project retail",
}
TOPIC_TO_SIGNAL = {"openings": "opening", "closures": "closure", "development": "development",
                   "rents": "other", "prices": "other"}


class ExaError(RuntimeError):
    pass


def exa_search(query, num_results=10, days_back=180, include_domains=None, exclude_domains=None,
               max_chars=4000, search_type="auto", api_key=None, retries=3):
    """POST /search with page text. Returns the list of result dicts (url, title, publishedDate, text, ...)."""
    key = api_key or os.environ.get("EXA_API_KEY")
    if not key:
        raise ExaError("EXA_API_KEY is not set")
    body = {"query": query, "type": search_type, "numResults": int(num_results),
            "contents": {"text": {"maxCharacters": int(max_chars)}}}
    if days_back:
        start = datetime.now(timezone.utc) - timedelta(days=days_back)
        body["startPublishedDate"] = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    if include_domains:
        body["includeDomains"] = list(include_domains)
    if exclude_domains:
        body["excludeDomains"] = list(exclude_domains)
    for attempt in range(retries):
        r = requests.post(EXA_URL, json=body, timeout=60,
                          headers={"x-api-key": key, "Content-Type": "application/json"})
        if r.status_code in (429, 503) and attempt < retries - 1:
            time.sleep(2 ** attempt * 2)
            continue
        if r.status_code != 200:
            raise ExaError(f"Exa {r.status_code}: {r.text[:300]}")
        return r.json().get("results", [])
    raise ExaError("Exa: retries exhausted")


def save_raw(query, topic, results, meta=None):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    h = hashlib.sha1(query.encode()).hexdigest()[:8]
    path = RAW_DIR / f"{ts}_{topic}_{h}.json"
    path.write_text(json.dumps({"query": query, "topic": topic, "fetched_at": ts, "meta": meta or {},
                                "results": results}, indent=1))
    return path


_RENT = re.compile(
    r"\$\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:/|per\s+)\s*(?:sq\.?\s?ft|sf|square\s+f(?:oo|ee)t)\b"
    r"(?:\s*(?:/|per\s+)\s*(yr|year|annum|annually|mo|month))?", re.I)


def baseline_extract(results, topic, area=None, zip5=None):
    """Pattern-based extraction. Returns {"signals": [...], "rents": [...]} in live.SCHEMAS format."""
    out = {"signals": [], "rents": []}
    for res in results:
        url, text = res.get("url"), res.get("text") or ""
        pub = (res.get("publishedDate") or datetime.now(timezone.utc).isoformat())[:10]
        sig = {"title": res.get("title") or url, "published_date": pub, "source_url": url,
               "kind": TOPIC_TO_SIGNAL.get(topic, "other"), "summary": re.sub(r"\s+", " ", text[:400]).strip()}
        if area:
            sig["area"] = area
        if zip5:
            sig["zip5"] = zip5
        out["signals"].append(sig)
        if topic == "rents":
            vals = []
            for m in _RENT.finditer(text):
                v = float(m.group(1))
                if m.group(2) and m.group(2).lower().startswith("mo"):
                    v *= 12
                if 8 <= v <= 150:
                    vals.append(v)
            if vals:   # one record per page: median of the quoted rents on that page
                vals.sort()
                rec = {"rent_psf_year": vals[len(vals) // 2], "observed_date": pub, "source_url": url,
                       "space_type": "asking", "n_quotes_on_page": len(vals)}
                if area:
                    rec["area"] = area
                if zip5:
                    rec["zip5"] = zip5
                out["rents"].append(rec)
    return out


def fetch_area(area, cuisine, zip5=None, topics=tuple(TOPICS), num_results=8, days_back=180,
               store=None, api_key=None, text_chars_for_agent=1500):
    """Run the topic queries for one area, save raw, ingest the baseline extraction.

    Returns a compact payload for the agent: per topic the results (trimmed text) so it can extract
    places / prices itself, plus the ingest reports of the baseline."""
    from live import LiveStore
    store = store or LiveStore()
    payload = {"area": area, "cuisine": cuisine, "zip5": zip5, "topics": {}}
    for topic in topics:
        q = TOPICS[topic].format(area=area, label=LABEL.get(cuisine, cuisine))
        res = exa_search(q, num_results=num_results, days_back=days_back, api_key=api_key)
        raw = save_raw(q, topic, res, {"area": area, "cuisine": cuisine, "zip5": zip5})
        ext = baseline_extract(res, topic, area, zip5)
        reports = {k: store.ingest(k, v, extractor="regex_baseline") for k, v in ext.items() if v}
        payload["topics"][topic] = {
            "query": q, "raw_file": raw.name, "baseline_ingest": reports,
            "results": [{"i": i, "title": r.get("title"), "url": r.get("url"), "publishedDate": r.get("publishedDate"),
                         "text": (r.get("text") or "")[:text_chars_for_agent]} for i, r in enumerate(res)],
        }
    return payload
