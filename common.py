"""Shared paths, cuisine taxonomy and loaders for the competitive-advantage pipeline."""
import glob
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)

import os


def _first_existing(*paths):
    for p in paths:
        if p.exists():
            return p
    return paths[0]


# Overture restaurant snapshot: env var RESTAURANT_CSV, else data/, else ~/Downloads
OVERTURE_CSV = Path(os.environ["RESTAURANT_CSV"]) if "RESTAURANT_CSV" in os.environ else _first_existing(
    ROOT / "data" / "chicago_restaurant_categories.csv",
    Path.home() / "Downloads" / "chicago_restaurant_categories.csv")
# team finance model: finance/ at repo root (or the local download used during development)
FINANCE_DIR = _first_existing(ROOT / "finance", ROOT / "repo" / "main" / "finance")

NOW = pd.Timestamp("2026-11-14")
SURVIVAL_DAYS = 1000          # ~ renewed the first 2-year license at least once
COHORT_YEARS = range(2013, 2023)  # 2022 openings have a full 3-year window by 2025-12
RADIUS_M = 500

# Overture category -> cuisine group. Checked against primary_category first,
# then against category_hierarchy from most to least specific.
GROUPS = {
    "mexican_latin": ["mexican", "taco", "texmex", "latin_american", "cuban", "puerto_rican", "colombian",
                      "peruvian", "ecuadorian", "venezuelan", "argentine", "salvadoran", "brazilian",
                      "guatemalan", "honduran", "empanada", "dominican", "costa_rican", "chilean",
                      "central_american"],
    "pizza": ["pizza"],
    "italian": ["italian"],
    "american": ["american", "burger", "hot_dog", "bar_and_grill", "comfort_food", "southern_american",
                 "soul_food", "cajun_and_creole", "cheesesteak", "diner"],
    "chicken": ["chicken", "chicken_wings"],
    "breakfast_brunch": ["breakfast_and_brunch", "pancake_house"],
    "chinese": ["chinese", "dim_sum", "sichuan", "taiwanese", "dumpling", "indo_chinese"],
    "japanese": ["sushi", "japanese", "ramen", "poke"],
    "other_asian": ["thai", "vietnamese", "korean", "asian", "asian_fusion", "pan_asian", "filipino",
                    "indonesian", "malaysian", "cambodian", "burmese", "mongolian", "southeast_asian",
                    "east_asian", "hawaiian", "polynesian"],
    "south_asian": ["indian", "pakistani", "nepalese", "south_indian", "afghani"],
    "med_mideast": ["mediterranean", "middle_eastern", "greek", "halal", "falafel", "lebanese", "turkish",
                    "persian", "moroccan", "doner_kebab", "egyptian", "arabian", "syrian", "kurdish",
                    "armenian"],
    "seafood": ["seafood", "fish_and_chips", "fish"],
    "bbq": ["barbecue"],
    "steakhouse": ["steakhouse"],
    "healthy": ["salad_bar", "health_food", "vegetarian", "vegan", "gluten_free", "acai_bowls", "soup"],
    "caribbean_african": ["caribbean", "jamaican", "african", "ethiopian", "nigerian", "senegalese",
                          "haitian", "trinidadian", "west_african", "south_african"],
    "european": ["french", "german", "polish", "eastern_european", "ukrainian", "czech", "british",
                 "spanish", "portuguese", "european", "scandinavian", "belgian", "irish", "russian",
                 "bulgarian", "romanian", "serbo_croatian", "swedish", "brasserie"],
}
_LOOKUP = {}
for g, keys in GROUPS.items():
    for k in keys:
        _LOOKUP[k] = g
        _LOOKUP[k + "_restaurant"] = g
CUISINES = list(GROUPS)
# team finance cuisines (finance/cuisine_params.json) -> model cuisine groups
FIN_MAP = {"fast_food": ["chicken", "american"], "italian": ["italian", "pizza"],
           "steakhouse": ["steakhouse"], "asian": ["chinese", "japanese", "other_asian", "south_asian"]}
NON_REST = "non_restaurant"


def cuisine_group(primary, hierarchy):
    if primary in _LOOKUP:
        return _LOOKUP[primary]
    try:
        chain = json.loads(hierarchy)
    except (TypeError, ValueError):
        chain = []
    for c in reversed(chain):
        if c in _LOOKUP:
            return _LOOKUP[c]
    return None  # generic "restaurant", buffet, cafeteria, ...


_SUFFIX = re.compile(r"\b(INC|LLC|L L C|CORP|CORPORATION|CO|LTD|THE|AND|OF|RESTAURANT|RESTAURANTS|CHICAGO)\b")


def norm_name(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", str(s).upper().replace("&", " AND "))
    return re.sub(r"\s+", " ", _SUFFIX.sub(" ", s)).strip()


def load_overture():
    d = pd.read_csv(OVERTURE_CSV, dtype=str)
    d["zip5"] = d.zip_code.str[:5]
    d["lat"] = d.latitude.astype(float)
    d["lon"] = d.longitude.astype(float)
    d["cuisine"] = [cuisine_group(p, h) for p, h in zip(d.primary_category, d.category_hierarchy)]
    d["name_norm"] = d.restaurant_name.map(norm_name)
    return d


def load_license_records():
    L = pd.concat([pd.read_csv(f, dtype=str) for f in sorted(glob.glob(str(RAW / "licenses" / "p_*.csv")))])
    for c in ["date_issued", "license_start_date", "expiration_date"]:
        L[c] = pd.to_datetime(L[c], errors="coerce")
    L["lat"] = pd.to_numeric(L.latitude, errors="coerce")
    L["lon"] = pd.to_numeric(L.longitude, errors="coerce")
    L["zip5"] = L.zip_code.str[:5]
    return L


def haversine_tree(lat, lon):
    from sklearn.neighbors import BallTree
    return BallTree(np.radians(np.c_[lat, lon]), metric="haversine")


EARTH_R = 6_371_000.0
