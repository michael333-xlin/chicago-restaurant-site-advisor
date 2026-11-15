#!/usr/bin/env bash
# Step 0: download every public input into data/raw/ (no credentials needed).
# Run from the repo root:  bash advantage/step0_download.sh
set -euo pipefail
RAW="${DATA_DIR:-data}/raw"
mkdir -p "$RAW/licenses" "$RAW/pop" "$RAW/ses" "$RAW/lodes" "$RAW/zips" "$RAW/inspections" "$RAW/cta" "$RAW/liquor"

# Business Licenses (r5kz-chrr), Retail Food Establishment only, paged by :id
for off in 0 50000 100000 150000 200000; do
  curl -s -G "https://data.cityofchicago.org/resource/r5kz-chrr.csv" \
    --data-urlencode "\$select=license_number,account_number,site_number,application_type,date_issued,license_start_date,expiration_date,license_status,doing_business_as_name,legal_name,address,zip_code,latitude,longitude,business_activity,community_area" \
    --data-urlencode "\$where=license_description='Retail Food Establishment'" \
    --data-urlencode "\$order=:id" --data-urlencode "\$limit=50000" --data-urlencode "\$offset=$off" \
    -o "$RAW/licenses/p_$off.csv"
done

# Chicago Population Counts by ZIP (85cm-7uqa), 2018-2021
curl -s "https://data.cityofchicago.org/resource/85cm-7uqa.csv?\$limit=5000" -o "$RAW/pop/pop.csv"
# Census socioeconomic indicators by community area 2008-2012 (kn9c-c2s2)
curl -s "https://data.cityofchicago.org/resource/kn9c-c2s2.csv" -o "$RAW/ses/ses.csv"

# Boundaries - ZIP Codes (unjd-c2ca), used for the citywide map layer
curl -s "https://data.cityofchicago.org/resource/unjd-c2ca.geojson?\$limit=200" -o "$RAW/zips/zips.geojson"

# Food Inspections (4ijn-s7e5), aggregated per license: used only to audit the survival label
curl -s -G "https://data.cityofchicago.org/resource/4ijn-s7e5.csv" \
  --data-urlencode "\$select=license_,min(inspection_date) as first_insp,max(inspection_date) as last_insp,count(*) as n_insp" \
  --data-urlencode "\$where=license_ IS NOT NULL" --data-urlencode "\$group=license_" --data-urlencode "\$limit=100000" \
  -o "$RAW/inspections/by_license.csv"
curl -s -G "https://data.cityofchicago.org/resource/4ijn-s7e5.csv" \
  --data-urlencode "\$select=license_,min(inspection_date) as first_oob" \
  --data-urlencode "\$where=results='Out of Business' AND license_ IS NOT NULL" --data-urlencode "\$group=license_" \
  --data-urlencode "\$limit=100000" -o "$RAW/inspections/oob_by_license.csv"

# Liquor Moratorium Districts - Dry Precincts (KML y49e-jumb; table 3cpd-5xpf). Historical city dataset (2011):
# in a precinct voted "dry" no liquor license can be issued. The tavern moratorium does not apply to restaurants.
curl -sfL -o "$RAW/liquor/dry_precincts.kml" "https://data.cityofchicago.org/download/y49e-jumb/application%2Fvnd.google-earth.kml%2Bxml"

# CTA 'L': station coordinates (8pix-ypme) + average weekday entries over the last 365 days of data (5neh-572f)
curl -s "https://data.cityofchicago.org/resource/8pix-ypme.csv?\$limit=1000" -o "$RAW/cta/stops.csv"
CTA_MAX=$(curl -s -G "https://data.cityofchicago.org/resource/5neh-572f.csv" --data-urlencode "\$select=max(date)" | tail -1 | tr -d '"' | cut -c1-10)
CTA_FROM=$(python3 -c "import datetime as d,sys; print((d.date.fromisoformat(sys.argv[1])-d.timedelta(days=365)).isoformat())" "$CTA_MAX")
curl -s -G "https://data.cityofchicago.org/resource/5neh-572f.csv" \
  --data-urlencode "\$select=station_id,avg(rides) as avg_weekday_rides,count(*) as n_days" \
  --data-urlencode "\$where=daytype='W' AND date > '$CTA_FROM'" --data-urlencode "\$group=station_id" \
  --data-urlencode "\$limit=1000" -o "$RAW/cta/weekday_rides.csv"
echo "$CTA_FROM $CTA_MAX" > "$RAW/cta/window.txt"

# LODES8 Illinois crosswalk + WAC 2011-2024
curl -sfL -o "$RAW/lodes/il_xwalk.csv.gz" "https://lehd.ces.census.gov/data/lodes/LODES8/il/il_xwalk.csv.gz"
LAST=$(( $(date +%Y) - 1 ))
for y in $(seq 2011 $LAST); do
  curl -sfL -o "$RAW/lodes/il_wac_$y.csv.gz" \
    "https://lehd.ces.census.gov/data/lodes/LODES8/il/wac/il_wac_S000_JT00_$y.csv.gz" \
    || { rm -f "$RAW/lodes/il_wac_$y.csv.gz"; echo "LODES WAC $y not published yet"; }
done
# LODES8 RAC (where workers live): block-level residential density and earnings mix for the web blocks
for y in $(seq $LAST -1 2022); do   # newest RAC year that is published
  if curl -sfL -o "$RAW/lodes/il_rac_$y.csv.gz" "https://lehd.ces.census.gov/data/lodes/LODES8/il/rac/il_rac_S000_JT00_$y.csv.gz"; then break; fi
  rm -f "$RAW/lodes/il_rac_$y.csv.gz"
done

date +%Y-%m-%d > "$RAW/AS_OF.txt"
python3 "$(dirname "$0")/snapshot.py" write
echo "done: $(ls "$RAW"/*/ | wc -l) files"
