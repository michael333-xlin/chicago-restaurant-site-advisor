"""Offline checks: recommend engine, survival scorer with optional inputs, and the report writer's number check.
Needs the step1-step3 outputs in output/. No network calls.

    python3 advantage/test_engine.py
"""
from narrative import check_numbers
from recommend import Engine
from survival import SiteSurvival

# 1. recommend runs on the base data and returns finance for every ranked area
eng = Engine()
r0 = eng.recommend(350_000, "asian", top_n=3)
assert r0["top"] and all("finance" in x and "license_survival_1000d" in x for x in r0["top"]), r0.keys()
print("1 recommend ok:", [x["area"] for x in r0["all_ranked"]])

# 2. optional operator inputs re-score the survival estimate; the ranking does not change
r1 = eng.recommend(350_000, "asian", top_n=3, prior_licenses=0, entity=False)
r2 = eng.recommend(350_000, "asian", top_n=3, prior_licenses=6, entity=True)
e = [{x["area"]: x["license_survival_1000d"]["model_estimate"] for x in r["top"]} for r in (r0, r1, r2)]
a = next(iter(e[0]))
assert e[1][a] < e[0][a] < e[2][a], e
assert [x["area"] for x in r0["all_ranked"]] == [x["area"] for x in r1["all_ranked"]]
print("2 operator inputs ok:", a, "first-time person", e[1][a], "| ZIP average", e[0][a], "| experienced LLC", e[2][a])

# 3. survival scorer: defaults are labelled as ZIP / city averages, user inputs as 'user', curve is non-increasing
s = SiteSurvival()
d = s.score("60614", "italian")
u = s.score("60614", "italian", prior_licenses=5, entity=True)
assert all(v["source"] != "user" for v in d["inputs"].values())
assert u["inputs"]["entity"]["source"] == "user" and u["p_license_1000d"] > d["p_license_1000d"]
c = d["license_curve"]
assert len(c) == 73 and all(x >= y for x, y in zip(c, c[1:])), c[:5]
print("3 survival ok:", d["p_license_1000d"], "->", u["p_license_1000d"], "with inputs")

# 4. number check: rounded numbers from the payload pass, invented ones are flagged
payload = {"sites": [{"startup_p50": 547213, "payback_months_p50": 23.4, "no_payback_5y": 0.021}], "survival": {"p": 0.78}}
good = {"bottom_line": "About $547k to open, a typical payback of 23 months, a 2% chance of no payback, 78% survival."}
bad = {"bottom_line": "Expect $612k and 41 months."}
assert check_numbers(good, payload) == [], check_numbers(good, payload)
assert [b["number"] for b in check_numbers(bad, payload)] == ["$612k", "41"], check_numbers(bad, payload)
rounded = {"why_here": "about 42,000 daytime workers and about 5,400 residents"}
assert check_numbers(rounded, {"traits": ["41,812 daytime workers vs 5,367 residents"]}) == []      # rounded to their own precision
assert [b["number"] for b in check_numbers(rounded, {"traits": ["40,100 daytime workers vs 5,367 residents"]})] == ["42,000"]
print("4 number check ok")

# 5. report structure: reference facts load with sources; messy model output is normalized; gaps are reported
from narrative import normalize, reference_facts, validate  # noqa: E402
facts = reference_facts()
assert len(facts) >= 10 and all(f["fact"] and f["source"] for f in facts), len(facts)
assert any("BACP" in (f["source"] or "") for f in facts)
messy = {"headline": "Short", "sites": [{"name": "State & Washington", "verdict": "Good."}], "risks": ["rent is a guess"],
         "next_steps": "visit the site", "chart_notes": None}
n = normalize(messy)
assert n["next_steps"] == ["visit the site"] and n["risks"][0]["level"] == "medium" and set(n["chart_notes"]) == {"startup_cost", "payback", "monthly_money"}
probs = validate(n, {"sites": [{"name": "State & Washington"}, {"name": "300 N Michigan"}]})
assert any('"sites" must have exactly 2' in p for p in probs) and any("risks" in p for p in probs), probs
print("5 report structure ok:", len(facts), "reference facts,", len(probs), "problems found in a deliberately incomplete draft")
print("ALL TESTS PASSED")
