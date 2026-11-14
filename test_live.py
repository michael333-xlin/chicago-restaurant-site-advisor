"""End-to-end test of the live-data path with SYNTHETIC records in a temporary store.

Nothing here touches data/live/. All URLs are example.com and all numbers are made up for the test.
    python3 advantage/test_live.py
"""
import os
import tempfile

from exa_fetch import ExaError, baseline_extract, exa_search
from live import LiveStore
from recommend import Engine

tmp = tempfile.mkdtemp(prefix="live_test_")
store = LiveStore(tmp)
U = "https://example.com/test/"

# 1. validation + de-duplication
bad = store.ingest("rents", [{"rent_psf_year": 999, "observed_date": "2026-11-01", "source_url": U + "a", "zip5": "60607"},
                             {"rent_psf_year": 40, "observed_date": "2026-11-01", "zip5": "60607"},
                             {"rent_psf_year": 40, "observed_date": "2026-11-01", "source_url": U + "b", "zip5": "99999"}])
assert bad["accepted"] == 0 and len(bad["rejected"]) == 3, bad
good = [{"rent_psf_year": r, "observed_date": "2026-11-01", "source_url": U + f"rent{i}", "zip5": "60607",
         "area": "West Loop"} for i, r in enumerate([38, 42, 46])]
assert store.ingest("rents", good)["accepted"] == 3
assert store.ingest("rents", good)["duplicates"] == 3
print("1 validation/dedupe ok")

# 2. baseline extraction from an Exa-shaped response
fake = [{"url": U + "listing", "title": "Retail space for lease", "publishedDate": "2026-10-20T00:00:00.000Z",
         "text": "2,400 SF former restaurant. Asking $36.50/SF/yr NNN. Also a 1,200 sf unit at $3.25 per sq ft per month."},
        {"url": U + "news", "title": "New tower approved", "publishedDate": "2026-10-01T00:00:00.000Z",
         "text": "The city approved a 40-story mixed-use tower with ground-floor retail."}]
ext = baseline_extract(fake, "rents", area="West Loop", zip5="60607")
assert ext["rents"][0]["rent_psf_year"] in (36.5, 39.0), ext["rents"]   # 36.5/yr and 3.25*12 = 39/yr
assert len(ext["signals"]) == 2
print("2 baseline extraction ok:", ext["rents"][0]["rent_psf_year"])

# 3. Exa without a key fails loudly
saved = os.environ.pop("EXA_API_KEY", None)
try:
    exa_search("test")
    raise AssertionError("expected ExaError")
except ExaError:
    print("3 missing EXA_API_KEY raises ExaError ok")
if saved:
    os.environ["EXA_API_KEY"] = saved

# 4. engine overlay
base = Engine().recommend(350_000, "asian", top_n=10)
store.ingest("prices", [{"avg_ticket_usd": t, "observed_date": "2026-11-01", "source_url": U + f"menu{i}",
                         "cuisine": "thai", "zip5": "60607"} for i, t in enumerate([21, 24, 27])])
store.ingest("signals", [{"title": "New tower approved", "published_date": "2026-10-01", "source_url": U + "news",
                          "kind": "development", "zip5": "60607"}])
# closure of a real Overture place in Chinatown (60616) and two synthetic openings there
eng0 = Engine()
victim = eng0.ov[(eng0.ov.zip5 == "60616") & (eng0.ov.cuisine == "chinese")].iloc[0]
store.ingest("places", [
    {"name": victim.restaurant_name, "status": "closed", "event_date": "2026-11-10", "source_url": U + "closed", "zip5": "60616"},
    {"name": "Test Noodle House One", "status": "open", "event_date": "2026-11-10", "source_url": U + "o1", "zip5": "60616", "cuisine": "chinese"},
    {"name": "Test Noodle House Two", "status": "open", "event_date": "2026-11-10", "source_url": U + "o2", "zip5": "60616", "cuisine": "chinese"},
])
eng = Engine(live=store)
live = eng.recommend(350_000, "asian", top_n=10)
rep = live["live_data"]
assert rep["places"]["opened_applied"] == 2 and rep["places"]["closed_applied"] == 1, rep["places"]
assert "West Loop" in [x["area"] for x in live["all_ranked"]], live["all_ranked"]
wl = next(x for x in live["top"] if x["area"] == "West Loop")
assert wl["finance"]["rent_psf_year"] == 42 and wl["boundary"] == "zip"
assert wl["live"]["prices"]["used_as_ticket"] and wl["finance"]["store"]["suggested_ticket"] == 24
assert wl["live"]["signals"][0]["kind"] == "development"
a0 = eng0.cai.query("zip5=='60616' and cuisine=='chinese'").actual.iloc[0]
a1 = eng.cai.query("zip5=='60616' and cuisine=='chinese'").actual.iloc[0]
assert a1 == a0 + 1, (a0, a1)
print("4 overlay ok: West Loop added, rank", [x["area"] for x in live["all_ranked"]].index("West Loop") + 1,
      "of", len(live["all_ranked"]), "| ticket", wl["finance"]["store"]["suggested_ticket"],
      "| Chinatown chinese count", a0, "->", a1)
print("base ranking:", [x["area"] for x in base["all_ranked"]])
print("live ranking:", [x["area"] for x in live["all_ranked"]])
print("ALL TESTS PASSED (temp store:", tmp, ")")
