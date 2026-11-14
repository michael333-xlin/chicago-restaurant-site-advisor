"""Extract Chicago ZIP (ZCTA) boundaries for the web prototype.

Reads the 2020 ZCTA cartographic boundary file already downloaded by the BrewGap
pipeline (data/raw/cb_2020_us_zcta520_500k.zip) and writes simplified polygons for
Chicago ZIPs 60601-60661 to web/src/data/chicago_zips.json.

Run from the repo root:
    .venv/bin/python web/scripts/build_chicago_zips.py
"""
from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "raw" / "cb_2020_us_zcta520_500k.zip"
OUT = ROOT / "web" / "src" / "data" / "chicago_zips.json"

CHICAGO_ZIPS = {f"606{n:02d}" for n in range(1, 62)}


def ring(coords) -> list[list[float]]:
    return [[round(x, 5), round(y, 5)] for x, y in coords]


def main() -> None:
    gdf = gpd.read_file(f"zip://{SRC}")
    gdf = gdf[gdf["ZCTA5CE20"].isin(CHICAGO_ZIPS)].to_crs(4326)
    out = []
    for _, row in gdf.sort_values("ZCTA5CE20").iterrows():
        geom = row.geometry.simplify(0.0002, preserve_topology=True)
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
        # Keep outer rings only; drop slivers under ~0.05 km² so H3 fill stays clean.
        polys = [p for p in polys if p.area > 5e-6]
        c = row.geometry.representative_point()
        minx, miny, maxx, maxy = row.geometry.bounds
        out.append({
            "zip": row["ZCTA5CE20"],
            "center": [round(c.x, 5), round(c.y, 5)],
            "bbox": [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)],
            "polygons": [ring(p.exterior.coords) for p in polys],
        })
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {len(out)} ZIPs to {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
