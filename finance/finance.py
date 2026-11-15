import json, math
from pathlib import Path

SCENARIOS = {"conservative": 0.7, "base": 1.0, "optimistic": 1.2}
HERE = Path(__file__).parent

def load(name):
    return json.loads((HERE / name).read_text())

def calc(budget, cuisine, area, params, rents, space_type="new",
         traffic_shock=1.0, food_shock=1.0, ticket_override=None):
    g, p, a = params["_global"], params[cuisine], rents[area]

    psf = p["startup_cost_psf_new"]
    if space_type == "second_gen":
        psf *= g["second_gen_factor"]

    reserve = budget * p["reserve_ratio"]
    capex = budget - reserve
    sqft = capex / psf
    if sqft < p["min_sqft"]:
        need = p["min_sqft"] * psf / (1 - p["reserve_ratio"])
        return {"feasible": False, "min_budget": round(need),
                "message": f"Budget too low for {p['label']}: needs at least ~${need:,.0f}"}
    sqft = min(sqft, p.get("target_sqft", p["max_sqft"]))  # size to a typical store, not the max the budget allows
    capex = sqft * psf                      # capex for the chosen size only
    reserve = budget - capex                # leftover budget becomes working capital
    seats = int(sqft / p["sqft_per_seat"])

    income = min(max(a["income_index"], 0.7), 1.5)
    ticket = ticket_override or round(p["base_ticket"] * math.sqrt(income))

    rent = sqft * a["rent_psf_year"] / 12
    min_labor = p["min_staff"] * p["avg_hourly_wage"] * g["hours_per_staff_month"]

    results = {}
    for name, factor in SCENARIOS.items():
        covers = (seats * p["turns_per_day"] * p["occupancy"]
                  * a.get("demand_index", 1.0) * factor * traffic_shock)
        revenue = covers * ticket * g["days_open_per_month"]
        food = revenue * p["food_cost_pct"] * food_shock
        labor = max(revenue * p["labor_pct"], min_labor)
        other = revenue * p["other_pct"] + p["fixed_other_monthly"]
        profit = revenue - rent - labor - food - other
        results[name] = {
            "monthly_revenue": round(revenue), "monthly_rent": round(rent),
            "monthly_labor": round(labor), "monthly_food": round(food),
            "monthly_other": round(other), "monthly_profit": round(profit),
            "payback_months": (round(capex / profit, 1) if profit > 0 and capex / profit <= 120 else None),
            "payback_note": ("loss" if profit <= 0 else "over 10 years" if capex / profit > 120 else ""),
        }

    base = results["base"]
    rent_ratio = rent / base["monthly_revenue"]
    prime = (base["monthly_food"] + base["monthly_labor"]) / base["monthly_revenue"]
    reserve_months = reserve / (rent + min_labor + p["fixed_other_monthly"])
    warnings = []
    if rent_ratio > 0.10:
        warnings.append(f"Rent is {rent_ratio:.0%} of revenue, above the 10% threshold")
    if prime > 0.65:
        warnings.append(f"Prime cost is {prime:.0%} of revenue, above 65%")
    if reserve_months < 6:
        warnings.append(f"Working capital covers only {reserve_months:.1f} months; at least 6 is recommended")
    if base["payback_months"] is None:
        warnings.append(f"Base case payback: {base['payback_note']}")

    return {
        "feasible": True,
        "inputs": {"budget": budget, "cuisine": p["label"], "area": area, "space_type": space_type},
        "store": {"sqft": round(sqft), "seats": seats, "capex": round(capex),
                  "sales_per_sqft_year": round(base["monthly_revenue"] * 12 / sqft),
                  "net_margin": round(base["monthly_profit"] / base["monthly_revenue"], 3),
                  "reserve": round(reserve), "suggested_ticket": ticket},
        "scenarios": results,
        "ratios": {"rent_ratio": round(rent_ratio, 3), "prime_cost": round(prime, 3),
                   "reserve_months": round(reserve_months, 1)},
        "warnings": warnings,
    }
