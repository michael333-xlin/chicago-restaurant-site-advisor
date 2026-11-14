"""Run every cuisine x neighborhood x space type combination and print a summary table.

Usage: python3 finance/run_all.py finance
"""
import sys
sys.path.insert(0, sys.argv[1])
from finance import calc, load

params, rents = load("cuisine_params.json"), load("rent_by_area.json")
CASES = {"fast_food": 250_000, "italian": 500_000, "steakhouse": 1_200_000, "asian": 350_000}

for space in ["new", "second_gen"]:
    print(f"\n===== Space type: {space} =====")
    for c, budget in CASES.items():
        print(f"\n-- {params[c]['label']}  budget ${budget:,}")
        for area in rents:
            r = calc(budget, c, area, params, rents, space_type=space)
            if not r["feasible"]:
                print(f"  {area:13s} {r['message']}")
                break
            s, b = r["store"], r["scenarios"]
            pb = lambda k: b[k]["payback_months"] or b[k]["payback_note"]
            print(f"  {area:13s} {s['sqft']:>5} sqft {s['seats']:>3} seats  "
                  f"rev/mo ${b['base']['monthly_revenue']:>7,}  profit/mo ${b['base']['monthly_profit']:>7,}  "
                  f"payback (months) low {pb('conservative')} / base {pb('base')} / high {pb('optimistic')}  "
                  f"sales/sqft ${s['sales_per_sqft_year']}  margin {s['net_margin']:.0%}  "
                  f"rent {r['ratios']['rent_ratio']:.0%}  prime {r['ratios']['prime_cost']:.0%}  "
                  f"reserve {r['ratios']['reserve_months']} mo")
